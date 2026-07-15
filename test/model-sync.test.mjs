/**
 * Test: shared AxonHub model sync service.
 *
 * Verifies concurrent fetch, merge, enrichment, TTL, stale-on-error, per-key
 * cache isolation, sorted output, and corrupt-cache handling.
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/** Replicates model-sync.ts's credential fingerprint for cache-file targeting. */
function fingerprint(normalizedRoot, apiKey) {
  const hash = createHash('sha256');
  hash.update(normalizedRoot);
  hash.update('\x00');
  hash.update(apiKey);
  return hash.digest('hex').slice(0, 16);
}

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-sync-test-'));

// Transpile modules
for (const file of [
  'url-helpers.ts',
  'model-types.ts',
  'model-metadata.generated.ts',
  'family-table.ts',
  'model-metadata.ts',
  'model-sync.ts',
]) {
  const source = fs.readFileSync(path.join(repo, file), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  }).outputText;
  fs.writeFileSync(path.join(out, file.replace(/\.ts$/, '.js')), js);
}
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ type: 'module' }));
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(out, 'node_modules'), 'dir');

const { syncAxonhubModels, findCachedEnrichedModel } = await import(
  pathToFileURL(path.join(out, 'model-sync.js'))
);

// --- Mock AxonHub server ---

let basicHandler = () => ({ data: [] });
let extendedHandler = () => ({ data: [] });

const server = createServer((req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const token = authHeader.slice(7);

    if (req.url === '/models') {
      const response = basicHandler(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else if (req.url === '/models?include=all') {
      const response = extendedHandler(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const instanceRoot = `http://127.0.0.1:${server.address().port}`;
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-agent-'));

// --- Tests ---

// Test 1: partial endpoint success, merge precedence
basicHandler = () => ({
  data: [
    { id: 'model-a', owned_by: 'openai', name: 'Basic A', type: 'chat' },
    { id: 'model-b', owned_by: 'anthropic', name: 'Basic B', type: 'chat' },
  ],
});
extendedHandler = () => ({
  data: [
    {
      id: 'model-a',
      owned_by: 'openai',
      name: 'Extended A',
      capabilities: { reasoning: true },
      context_length: 8000,
      max_output_tokens: 4000,
      pricing: { input: 1.0, output: 2.0 },
      type: 'chat',
    },
  ],
});

const result1 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-1',
  agentDir,
  forceRefresh: true,
});

assert.equal(result1.status.fresh, true, 'should be fresh');
assert.equal(result1.status.stale, false, 'should not be stale');
assert.equal(result1.models.length, 2, 'should merge both models');

const modelA = result1.models.find((m) => m.id === 'model-a');
assert(modelA, 'model-a should exist');
assert.equal(modelA.name, 'Extended A', 'extended fields should take precedence');
assert.equal(modelA.reasoning, true, 'extended reasoning should be merged');
assert.equal(modelA.contextWindow, 8000, 'extended context should be merged');

const modelB = result1.models.find((m) => m.id === 'model-b');
assert(modelB, 'model-b should exist');
assert.equal(modelB.name, 'Basic B', 'basic-only model should be present');

// Test 2: per-key cache isolation
basicHandler = () => ({
  data: [{ id: 'model-x', owned_by: 'openai', name: 'X for key2', type: 'chat' }],
});
extendedHandler = () => ({ data: [] });

const result2 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-2',
  agentDir,
  forceRefresh: true,
});

assert.equal(result2.models.length, 1, 'key-2 should see different models');
assert.equal(result2.models[0].id, 'model-x', 'key-2 should see model-x');

// Verify key-1 cache is still intact
const cached1 = findCachedEnrichedModel(instanceRoot, 'model-a');
assert(cached1, 'key-1 model-a should still be cached');
assert.equal(cached1.name, 'Extended A', 'key-1 cache should be unchanged');

// Test 3: TTL freshness (short TTL, no force-refresh)
const result3 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-2',
  agentDir,
  ttlMs: 50,
});

assert.equal(result3.status.fresh, true, 'within TTL should be fresh');
assert.equal(result3.models.length, 1, 'cached result should be returned');

await new Promise((resolve) => setTimeout(resolve, 100));

basicHandler = () => ({
  data: [{ id: 'model-y', owned_by: 'anthropic', name: 'Y after TTL', type: 'chat' }],
});

const result4 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-2',
  agentDir,
  ttlMs: 50,
});

assert.equal(result4.models.length, 1, 'expired TTL should trigger refresh');
assert.equal(result4.models[0].id, 'model-y', 'should fetch new model after TTL');

// Test 4: stale-on-error fallback
basicHandler = () => {
  throw new Error('Network failure');
};
extendedHandler = () => {
  throw new Error('Network failure');
};

const result5 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-2',
  agentDir,
  forceRefresh: true,
});

assert.equal(result5.status.fresh, false, 'failed fetch should not be fresh');
assert.equal(result5.status.stale, true, 'should return stale cache on error');
assert.equal(result5.models.length, 1, 'stale models should be returned');
assert.equal(result5.models[0].id, 'model-y', 'stale cache should have previous model');
assert(result5.status.error, 'error should be set');

// Test 5: no cache, fetch fails
const result6 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-never-cached',
  agentDir,
  forceRefresh: true,
});

assert.equal(result6.status.fresh, false, 'failed fetch with no cache should not be fresh');
assert.equal(result6.status.stale, false, 'no cache to return as stale');
assert.equal(result6.models.length, 0, 'should return empty models');
assert(result6.status.error, 'error should be set');

// Test 6: sorted output
basicHandler = () => ({
  data: [
    { id: 'model-z', owned_by: 'openai', name: 'Z', type: 'chat' },
    { id: 'model-a', owned_by: 'anthropic', name: 'A', type: 'chat' },
    { id: 'model-m', owned_by: 'google', name: 'M', type: 'chat' },
  ],
});
extendedHandler = () => ({ data: [] });

const result7 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-sorted',
  agentDir,
  forceRefresh: true,
});

const ids = result7.models.map((m) => m.id);
assert.deepEqual(ids, ['model-a', 'model-m', 'model-z'], 'models should be sorted by id');

// Test 7: discard non-chat models
basicHandler = () => ({
  data: [
    { id: 'chat-model', owned_by: 'openai', name: 'Chat', type: 'chat' },
    { id: 'image-model', owned_by: 'openai', name: 'Image', type: 'image' },
    { id: 'embed-model', owned_by: 'openai', name: 'Embed', type: 'embedding' },
  ],
});
extendedHandler = () => ({ data: [] });

const result8 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-filter',
  agentDir,
  forceRefresh: true,
});

assert.equal(result8.models.length, 1, 'only chat models should be returned');
assert.equal(result8.models[0].id, 'chat-model', 'chat-model should be present');

// Test 8: findCachedEnrichedModel synchronous lookup
const found = findCachedEnrichedModel(instanceRoot, 'chat-model');
assert(found, 'findCachedEnrichedModel should find warm entry');
assert.equal(found.id, 'chat-model', 'found model should match');
assert.equal(found.protocolFamily, 'openai-completions', 'enriched metadata should be present');

const notFound = findCachedEnrichedModel(instanceRoot, 'nonexistent-model');
assert.equal(notFound, undefined, 'nonexistent model should return undefined');

// Test 9: corrupt cache is ignored
const cacheDir = path.join(agentDir, '.axonhub-model-cache');
fs.mkdirSync(cacheDir, { recursive: true });
const corruptFp = fingerprint(instanceRoot, 'key-corrupt');
const corruptPath = path.join(cacheDir, `${corruptFp}.json`);
fs.writeFileSync(corruptPath, '{invalid json', 'utf8');

basicHandler = () => ({
  data: [{ id: 'fresh-model', owned_by: 'openai', name: 'Fresh', type: 'chat' }],
});
extendedHandler = () => ({ data: [] });

const result9 = await syncAxonhubModels({
  instanceRoot,
  apiKey: 'key-corrupt',
  agentDir,
});

assert.equal(result9.status.fresh, true, 'corrupt cache should be ignored, fresh fetch');
assert.equal(result9.models.length, 1, 'should fetch from server');
assert.equal(result9.models[0].id, 'fresh-model', 'should have fresh model');

server.close();

console.log('model sync service OK');

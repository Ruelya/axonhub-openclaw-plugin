import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Transpile the codex-toml module (and its dependency-free surface) into a
// temp dir so we can import it as ESM without a full build.
const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-codex-toml-'));
for (const file of ['codex-toml.ts']) {
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

const {
  buildManagedBlock,
  reconcileBlockText,
  removeBlockText,
  hasUnmarkedProviderTable,
  reconcileCodexProviderBlock,
  removeCodexProviderBlock,
  beginMarker,
  endMarker,
} = await import(pathToFileURL(path.join(out, 'codex-toml.js')));

const PROVIDER = 'axonhub_openclaw_7f3a91c2d8ab';
const OPTS = {
  providerId: PROVIDER,
  instanceRoot: 'https://axon.example.com',
  wrapperPath: '/home/agent/codex-home/axonhub-openclaw-auth/' + PROVIDER + '.sh',
};

test('codex toml block reconciliation', async () => {
  // --- buildManagedBlock shape ---
  const block = buildManagedBlock(OPTS);
  assert.ok(block.startsWith(beginMarker(PROVIDER)), 'starts with begin marker');
  assert.ok(block.trimEnd().endsWith(endMarker(PROVIDER)), 'ends with end marker');
  assert.match(block, /base_url = "https:\/\/axon\.example\.com\/v1"/, 'routes to /v1 responses endpoint');
  assert.match(block, /wire_api = "responses"/);
  assert.match(block, /command = ".*\.sh"/, 'auth command points at wrapper');
  assert.ok(!block.includes('sk-'), 'no credential in block');

  // --- insert into empty content ---
  const inserted = reconcileBlockText('', OPTS);
  assert.ok(inserted.includes(beginMarker(PROVIDER)));
  assert.ok(inserted.endsWith('\n'));

  // --- idempotence: reconciling the same input is byte-stable ---
  const twice = reconcileBlockText(inserted, OPTS);
  assert.equal(twice, inserted, 'idempotent reconcile produces identical output');

  // --- preserves unrelated user TOML ---
  const userToml = [
    '# my personal codex config',
    '[model_providers.openai]',
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    '',
  ].join('\n');
  const merged = reconcileBlockText(userToml, OPTS);
  assert.ok(merged.includes('# my personal codex config'), 'user comment preserved');
  assert.ok(merged.includes('[model_providers.openai]'), 'user provider preserved');
  assert.ok(merged.includes(beginMarker(PROVIDER)), 'managed block appended');

  // --- update in place: changing wrapperPath replaces only the managed block ---
  const updatedOpts = { ...OPTS, wrapperPath: '/new/path/' + PROVIDER + '.sh' };
  const updated = reconcileBlockText(merged, updatedOpts);
  assert.ok(updated.includes('/new/path/'), 'wrapper path updated');
  assert.ok(!updated.includes('/home/agent/codex-home/'), 'old wrapper path removed');
  assert.ok(updated.includes('[model_providers.openai]'), 'user provider still preserved after update');
  // Only one managed block should exist.
  const beginCount = updated.split(beginMarker(PROVIDER)).length - 1;
  assert.equal(beginCount, 1, 'exactly one managed block after update');

  // --- collision detection: unmarked user table with same id fails closed ---
  const colliding = [
    '[model_providers.' + PROVIDER + ']',
    'name = "user owned"',
    '',
  ].join('\n');
  assert.equal(hasUnmarkedProviderTable(colliding, PROVIDER), true, 'detects unmarked collision');
  assert.throws(
    () => reconcileBlockText(colliding, OPTS),
    /refusing to overwrite/,
    'fails closed on unmarked collision',
  );

  // Our own managed block is NOT a collision.
  assert.equal(hasUnmarkedProviderTable(inserted, PROVIDER), false, 'managed block is not a collision');

  // --- removeBlockText removes only the managed block ---
  const removed = removeBlockText(merged, PROVIDER);
  assert.ok(!removed.includes(beginMarker(PROVIDER)), 'managed block removed');
  assert.ok(removed.includes('[model_providers.openai]'), 'user provider preserved after removal');
  // Removing when absent is a no-op.
  assert.equal(removeBlockText(userToml, PROVIDER), userToml, 'removal is no-op when block absent');

  // --- filesystem round trip: reconcile → file has 0600 → remove ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-codex-home-'));
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, userToml);

  await reconcileCodexProviderBlock(configPath, OPTS);
  const onDisk = fs.readFileSync(configPath, 'utf8');
  assert.ok(onDisk.includes(beginMarker(PROVIDER)), 'block written to disk');
  assert.ok(onDisk.includes('[model_providers.openai]'), 'user config preserved on disk');
  const mode = fs.statSync(configPath).mode & 0o777;
  assert.equal(mode, 0o600, 'config written with 0600');

  // Idempotent on disk: second reconcile leaves bytes unchanged.
  await reconcileCodexProviderBlock(configPath, OPTS);
  assert.equal(fs.readFileSync(configPath, 'utf8'), onDisk, 'disk reconcile idempotent');

  const didRemove = await removeCodexProviderBlock(configPath, PROVIDER);
  assert.equal(didRemove, true, 'removal reports change');
  const afterRemove = fs.readFileSync(configPath, 'utf8');
  assert.ok(!afterRemove.includes(beginMarker(PROVIDER)), 'block gone from disk');
  assert.ok(afterRemove.includes('[model_providers.openai]'), 'user config still on disk');

  // Concurrent reconciles serialize without corruption.
  fs.writeFileSync(configPath, '');
  await Promise.all([
    reconcileCodexProviderBlock(configPath, OPTS),
    reconcileCodexProviderBlock(configPath, OPTS),
    reconcileCodexProviderBlock(configPath, OPTS),
  ]);
  const concurrent = fs.readFileSync(configPath, 'utf8');
  const concurrentBegins = concurrent.split(beginMarker(PROVIDER)).length - 1;
  assert.equal(concurrentBegins, 1, 'concurrent reconciles produce exactly one block');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('codex toml management OK');
});

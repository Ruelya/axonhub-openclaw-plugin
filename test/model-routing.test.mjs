import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-plugin-routing-test-'));

// Transpile all modules the test needs.
const modules = [
  'url-helpers.ts',
  'model-types.ts',
  'model-metadata.generated.ts',
  'family-table.ts',
  'model-metadata.ts',
];

for (const file of modules) {
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

const urlHelpers = await import(pathToFileURL(path.join(out, 'url-helpers.js')));
const metadata = await import(pathToFileURL(path.join(out, 'model-metadata.js')));

// --- URL normalization ---
assert.equal(
  urlHelpers.normalizeAxonhubInstanceRoot('http://localhost:8090/v1'),
  'http://localhost:8090',
);
assert.equal(
  urlHelpers.normalizeAxonhubInstanceRoot('https://axonhub.example.com/v1/'),
  'https://axonhub.example.com',
);
assert.equal(
  urlHelpers.normalizeAxonhubInstanceRoot('https://axonhub.example.com/'),
  'https://axonhub.example.com',
);
assert.equal(
  urlHelpers.getAxonhubOpenAIEndpoint('http://localhost:8090'),
  'http://localhost:8090/v1',
);
assert.equal(
  urlHelpers.getAxonhubAnthropicEndpoint('http://localhost:8090/v1'),
  'http://localhost:8090/anthropic/v1',
);
assert.equal(
  urlHelpers.getAxonhubGeminiEndpoint('http://localhost:8090'),
  'http://localhost:8090/gemini/v1beta',
);

// --- Protocol family resolution ---

const BASE_URL = 'http://localhost:8090';

function enrichTestModel(id, owner) {
  const discovered = {
    id,
    name: id,
    owner,
    contextWindow: 200000,
    maxTokens: 16384,
    reasoning: true,
    vision: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return metadata.enrichModel(discovered, BASE_URL);
}

// Anthropic Claude models → anthropic-messages + /anthropic/v1
const claude47 = enrichTestModel('claude-opus-4-7', 'anthropic');
assert.equal(claude47.protocolFamily, 'anthropic');
assert.equal(claude47.api, 'anthropic-messages');
assert.equal(claude47.baseUrl, 'http://localhost:8090/anthropic/v1');
assert.deepEqual(claude47.supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);

const claude46 = enrichTestModel('claude-sonnet-4-6', 'anthropic');
assert.equal(claude46.protocolFamily, 'anthropic');
assert.equal(claude46.api, 'anthropic-messages');
assert.deepEqual(claude46.supportedReasoningEfforts, ['low', 'medium', 'high', 'max']);

const claudeMythos = enrichTestModel('claude-mythos-preview', 'anthropic');
assert.equal(claudeMythos.protocolFamily, 'anthropic');
assert.equal(claudeMythos.api, 'anthropic-messages');
assert.deepEqual(claudeMythos.supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);

// DeepSeek models → openai-completions + /v1
const deepseekPro = enrichTestModel('deepseek-v4-pro', 'deepseek');
assert.equal(deepseekPro.protocolFamily, 'openai-completions');
assert.equal(deepseekPro.api, 'openai-completions');
assert.equal(deepseekPro.baseUrl, 'http://localhost:8090/v1');
assert.deepEqual(deepseekPro.supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);

const deepseekFlash = enrichTestModel('deepseek-v4-flash', 'deepseek');
assert.equal(deepseekFlash.protocolFamily, 'openai-completions');
assert.equal(deepseekFlash.api, 'openai-completions');

// Gemini models → google-generative-ai + /gemini/v1beta (owner-based)
const gemini3Flash = enrichTestModel('gemini-3-flash-preview', 'google');
assert.equal(gemini3Flash.protocolFamily, 'gemini');
assert.equal(gemini3Flash.api, 'google-generative-ai');
assert.equal(gemini3Flash.baseUrl, 'http://localhost:8090/gemini/v1beta');
assert.deepEqual(
  gemini3Flash.supportedReasoningEfforts,
  ['low', 'medium', 'high', 'xhigh'],
  'gemini-3 efforts come from family-table fallback',
);

// Gemini models → gemini by id pattern even without owner
const geminiNoOwner = enrichTestModel('gemini-3.1-pro-preview', undefined);
assert.equal(geminiNoOwner.protocolFamily, 'gemini');
assert.equal(geminiNoOwner.api, 'google-generative-ai');

// OpenAI gpt-5/o-series → openai-completions + /v1 (conservative fallback).
// Reasoning efforts come from the family-table compatibility fallback since
// these families are not yet in the generated metadata artifact.
const gpt55 = enrichTestModel('gpt-5.5', 'openai');
assert.equal(gpt55.protocolFamily, 'openai-completions');
assert.equal(gpt55.api, 'openai-completions');
assert.equal(gpt55.baseUrl, 'http://localhost:8090/v1');
assert.deepEqual(
  gpt55.supportedReasoningEfforts,
  ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.5 efforts come from family-table fallback',
);

const o3 = enrichTestModel('o3', 'openai');
assert.equal(o3.protocolFamily, 'openai-completions');
assert.equal(o3.api, 'openai-completions');
assert.deepEqual(
  o3.supportedReasoningEfforts,
  ['low', 'medium', 'high', 'xhigh'],
  'o3 efforts come from family-table fallback',
);

// Unknown model → conservative openai-completions fallback
const unknown = enrichTestModel('totally-unknown-model', 'unknown-vendor');
assert.equal(unknown.protocolFamily, 'openai-completions');
assert.equal(unknown.api, 'openai-completions');
assert.equal(unknown.baseUrl, 'http://localhost:8090/v1');
assert.equal(unknown.supportedReasoningEfforts, undefined);

// Claude by id pattern (owner missing) → anthropic
const claudeNoOwner = enrichTestModel('claude-3-5-sonnet', undefined);
assert.equal(claudeNoOwner.protocolFamily, 'anthropic');
assert.equal(claudeNoOwner.api, 'anthropic-messages');

// Model id normalization (case-insensitive, axonhub/ prefix stripped)
const claudeUppercase = enrichTestModel('CLAUDE-OPUS-4-7', 'anthropic');
assert.equal(claudeUppercase.protocolFamily, 'anthropic');

const claudePrefixed = enrichTestModel('axonhub/claude-opus-4-7', 'anthropic');
assert.equal(claudePrefixed.protocolFamily, 'anthropic');

// Forward-compat: API-provided reasoning efforts take precedence over metadata
const apiProvidedEfforts = enrichTestModel('claude-opus-4-7', 'anthropic');
apiProvidedEfforts.supportedReasoningEfforts = ['low', 'high']; // simulated API override
const reEnriched = metadata.enrichModel(
  { ...apiProvidedEfforts, supportedReasoningEfforts: ['low', 'high'] },
  BASE_URL,
);
assert.deepEqual(
  reEnriched.supportedReasoningEfforts,
  ['low', 'high'],
  'API-provided efforts take precedence',
);

console.log('model routing OK');

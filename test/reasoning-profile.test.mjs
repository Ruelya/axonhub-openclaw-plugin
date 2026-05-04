import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-plugin-test-'));
for (const file of ['index.ts', 'onboard.ts', 'provider-catalog.ts', 'family-table.ts']) {
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

const plugin = (await import(pathToFileURL(path.join(out, 'index.js')))).default;
const familyTable = await import(pathToFileURL(path.join(out, 'family-table.js')));

let provider;
plugin.register({ registerProvider(value) { provider = value; } });
assert(provider, 'provider should be registered');

function profile(modelId, reasoning = true) {
  return provider.resolveThinkingProfile({ provider: 'axonhub', modelId, reasoning });
}
function levels(modelId, reasoning = true) {
  return profile(modelId, reasoning).levels.map((entry) => entry.id);
}

// --- Existing locked baseline (must stay green) ---
assert.deepEqual(levels('deepseek-v4-flash'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('axonhub/deepseek-v4-pro'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('gpt-5.5'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('gpt-5.4-mini'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('gpt-5.3-codex'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('gpt-5.2'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('ordinary-reasoning-model'), ['off', 'minimal', 'low', 'medium', 'high']);
assert.equal(provider.resolveThinkingProfile({ provider: 'axonhub', modelId: 'plain-chat', reasoning: false }), null);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'deepseek-v4-flash' }), true);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'plain-chat' }), false);

// --- New: OpenAI o3 / o4-mini ---
assert.deepEqual(levels('o3'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'o3 should expose xhigh+max');
assert.deepEqual(levels('o4-mini'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'o4-mini should expose xhigh+max');
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'o3' }), true);

// --- New: Anthropic Claude opus-4.7 / sonnet-4.7 — full xhigh+adaptive+max ---
assert.deepEqual(
  levels('claude-opus-4-7'),
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'],
  'claude-opus-4-7 should expose xhigh+adaptive+max',
);
assert.deepEqual(
  levels('claude-opus-4.7'),
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'],
  'dot-form claude-opus-4.7 should be recognized too',
);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'claude-opus-4-7' }), true);

// --- New: Anthropic Claude opus-4.6 / sonnet-4.6 — adaptive only, no xhigh / no max ---
assert.deepEqual(
  levels('claude-opus-4-6'),
  ['off', 'minimal', 'low', 'medium', 'high', 'adaptive'],
  'claude-opus-4-6 should expose adaptive but NOT xhigh',
);
assert.deepEqual(
  levels('claude-sonnet-4.6'),
  ['off', 'minimal', 'low', 'medium', 'high', 'adaptive'],
  'claude-sonnet-4.6 should match too',
);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'claude-opus-4-6' }), false);

// --- New: Google Gemini 3.x — xhigh, no max ---
assert.deepEqual(
  levels('gemini-3-flash-preview'),
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  'gemini-3* should expose xhigh',
);
assert.deepEqual(
  levels('gemini-3.1-pro-preview'),
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  'gemini-3.x* prefix should match',
);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'gemini-3-flash-preview' }), true);

// --- New: family helpers expose supportsAxonhubMaxThinking gating ---
assert.equal(familyTable.supportsAxonhubMaxThinking('gpt-5.5'), true, 'gpt-5.5 should support max wrapper');
assert.equal(familyTable.supportsAxonhubMaxThinking('deepseek-v4-pro'), true, 'deepseek-v4-pro should support max wrapper');
assert.equal(familyTable.supportsAxonhubMaxThinking('claude-opus-4-7'), true, 'claude-opus-4-7 should support max wrapper');
assert.equal(familyTable.supportsAxonhubMaxThinking('claude-opus-4-6'), false, 'claude-opus-4-6 should NOT activate max wrapper');
assert.equal(familyTable.supportsAxonhubMaxThinking('gemini-3-flash-preview'), false, 'gemini-3* should NOT activate max wrapper');
assert.equal(familyTable.supportsAxonhubMaxThinking('ordinary-reasoning-model'), false, 'unknown reasoning model should NOT activate max wrapper');

// --- New: family resolution returns null for unknown ids ---
assert.equal(familyTable.resolveAxonhubFamily('plain-chat'), null);
assert.equal(familyTable.resolveAxonhubFamily('MiniMax-M2.7'), null);

// --- New: family resolution sets supportedEffortsForCompat for non-OpenAI families that need it ---
assert.deepEqual(
  familyTable.resolveAxonhubFamily('claude-opus-4-7').supportedEffortsForCompat,
  ['low', 'medium', 'high', 'xhigh'],
);
assert.deepEqual(
  familyTable.resolveAxonhubFamily('deepseek-v4-pro').supportedEffortsForCompat,
  ['low', 'medium', 'high', 'xhigh'],
);
assert.deepEqual(
  familyTable.resolveAxonhubFamily('gemini-3-flash-preview').supportedEffortsForCompat,
  ['low', 'medium', 'high', 'xhigh'],
);
// OpenAI gpt-5* defers to OpenClaw built-in registry — no override.
assert.equal(familyTable.resolveAxonhubFamily('gpt-5.5').supportedEffortsForCompat, undefined);

// --- New: Forward-compat — readApiReasoningEfforts reads alias keys ---
const apiEntryWithEfforts = {
  capabilities: {
    reasoning: true,
    reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
  },
};
assert.deepEqual(
  familyTable.readApiReasoningEfforts(apiEntryWithEfforts),
  ['low', 'medium', 'high', 'xhigh'],
);
assert.equal(
  familyTable.readApiReasoningEfforts({ capabilities: { reasoning: true } }),
  undefined,
  'absence of effort fields returns undefined',
);
assert.deepEqual(
  familyTable.readApiReasoningEfforts({ capabilities: { reasoning_levels: ['high'] } }),
  ['high'],
  'reasoning_levels alias works',
);
assert.equal(
  familyTable.readApiReasoningEfforts(null),
  undefined,
  'null entry tolerated',
);
assert.equal(
  familyTable.readApiReasoningEfforts({ capabilities: { reasoning_efforts: [] } }),
  undefined,
  'empty list returns undefined',
);

// --- New: profile.defaultLevel is set when reasoning=true and family is unknown ---
const ordinary = profile('ordinary-reasoning-model', true);
assert.equal(ordinary.defaultLevel, 'low', 'unknown reasoning models default to low');

// --- New: Claude 4.6 keeps its own defaultLevel from the SDK helper ---
const claude46 = profile('claude-opus-4-6', true);
assert.equal(claude46.defaultLevel, 'adaptive', 'claude-opus-4-6 default is adaptive (from shared helper)');

// --- New: Claude 4.7 keeps its own SDK-provided defaultLevel ('off') ---
const claude47 = profile('claude-opus-4-7', true);
assert.equal(claude47.defaultLevel, 'off', 'claude-opus-4-7 default is off (from shared helper)');

// --- New: gpt-5.5 still gets defaultLevel="low" (family profile has no defaultLevel) ---
const gpt55 = profile('gpt-5.5', true);
assert.equal(gpt55.defaultLevel, 'low', 'gpt-5.5 default falls back to low');

// --- New: non-reasoning unknown model returns null ---
assert.equal(profile('totally-unknown-chat-model', false), null);

console.log('reasoning profile compatibility OK');

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-codex-provider-id-'));
for (const file of ['codex-provider-id.ts']) {
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
  deriveCodexProviderId,
  isPluginCodexProviderId,
  CODEX_PROVIDER_ID_PREFIX,
} = await import(pathToFileURL(path.join(out, 'codex-provider-id.js')));

test('codex provider id derivation', () => {
  // --- deterministic: same inputs produce same id ---
  const id1 = deriveCodexProviderId('/home/agent/.openclaw/agents/alice', 'work');
  const id2 = deriveCodexProviderId('/home/agent/.openclaw/agents/alice', 'work');
  assert.equal(id1, id2, 'same inputs produce identical id');

  // --- well-formed: prefix + hex digest ---
  assert.ok(id1.startsWith(CODEX_PROVIDER_ID_PREFIX), 'id carries plugin prefix');
  const digest = id1.slice(CODEX_PROVIDER_ID_PREFIX.length);
  assert.equal(digest.length, 12, 'digest is 12 hex chars');
  assert.match(digest, /^[0-9a-f]+$/, 'digest is lowercase hex');

  // --- distinct inputs produce distinct ids ---
  const idAlice = deriveCodexProviderId('/home/agent/.openclaw/agents/alice', undefined);
  const idBob = deriveCodexProviderId('/home/agent/.openclaw/agents/bob', undefined);
  assert.notEqual(idAlice, idBob, 'different agentDir produces different id');

  const idDefault = deriveCodexProviderId('/home/agent/.openclaw/agents/alice', undefined);
  const idWork = deriveCodexProviderId('/home/agent/.openclaw/agents/alice', 'work');
  assert.notEqual(idDefault, idWork, 'different profileId produces different id');

  // --- undefined agentDir uses stable sentinel ---
  const noAgent1 = deriveCodexProviderId(undefined, 'personal');
  const noAgent2 = deriveCodexProviderId(undefined, 'personal');
  assert.equal(noAgent1, noAgent2, 'undefined agentDir is deterministic');

  // --- field separator prevents collision ---
  // Without a separator, ("a b", "c") and ("a", "b c") could hash identically.
  const id_a_bc = deriveCodexProviderId('a', 'b c');
  const id_ab_c = deriveCodexProviderId('a b', 'c');
  assert.notEqual(id_a_bc, id_ab_c, 'field separator prevents agentDir/profileId collision');

  // --- plugin ownership check ---
  assert.equal(isPluginCodexProviderId(id1), true, 'recognizes plugin-generated id');
  assert.equal(isPluginCodexProviderId('openai'), false, 'rejects unrelated provider');
  assert.equal(isPluginCodexProviderId('axonhub'), false, 'rejects normal axonhub provider');
  assert.equal(isPluginCodexProviderId(CODEX_PROVIDER_ID_PREFIX + 'abc123'), true, 'accepts any id with plugin prefix');

  console.log('codex provider id derivation OK');
});

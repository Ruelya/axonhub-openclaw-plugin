import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-codex-bridge-'));

// Transpile codex-bridge and all its dependencies (except SDK imports, which
// tests mock or inject).
for (const file of [
  'url-helpers.ts',
  'onboard.ts',
  'codex-runtime.ts',
  'codex-provider-id.ts',
  'codex-home.ts',
  'codex-toml.ts',
  'codex-bridge.ts',
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

const { handleBeforeModelResolve } = await import(
  pathToFileURL(path.join(out, 'codex-bridge.js'))
);

const HELPER_PATH = '/usr/local/lib/axonhub-openclaw-plugin/codex-credential-helper.js';

/** Stub OpenClawConfig for tests. */
function makeConfig(overrides = {}) {
  return {
    models: { providers: { axonhub: { agentRuntime: { id: 'codex' } } } },
    ...overrides,
  };
}

/** Stub PluginHookAgentContext. */
function makeContext(overrides = {}) {
  return {
    modelProviderId: 'axonhub',
    modelId: 'gpt-5',
    agentId: 'main',
    sessionKey: 'test-session',
    ...overrides,
  };
}

test('codex bridge projection', async () => {
  // --- Non-axonhub provider → no projection ---
  {
    const ctx = makeContext({ modelProviderId: 'openai' });
    const result = await handleBeforeModelResolve({}, ctx, makeConfig(), HELPER_PATH);
    assert.equal(result, undefined, 'non-axonhub provider bypasses bridge');
  }

  // --- No effective codex runtime → no projection ---
  {
    const config = makeConfig({
      models: { providers: { axonhub: { agentRuntime: { id: 'openclaw' } } } },
    });
    const result = await handleBeforeModelResolve({}, makeContext(), config, HELPER_PATH);
    assert.equal(result, undefined, 'non-codex runtime bypasses bridge');
  }

  // --- Kill-switch env disables bridge entirely ---
  {
    process.env.AXONHUB_CODEX_BRIDGE_DISABLED = '1';
    const result = await handleBeforeModelResolve({}, makeContext(), makeConfig(), HELPER_PATH);
    assert.equal(result, undefined, 'kill-switch disables bridge');
    delete process.env.AXONHUB_CODEX_BRIDGE_DISABLED;
  }

  // --- axonhub + codex runtime → projection returned ---
  // Use agentId: undefined so the bridge does NOT call the SDK's resolveAgentDir
  // (which would resolve to a real, unpredictable path). With no agent dir,
  // resolveCodexHome falls back to CODEX_HOME, which we point at a temp dir so
  // the managed TOML lands somewhere we can assert on deterministically.
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmpHome;
    try {
      const config = makeConfig({ baseUrl: undefined });
      const ctx = makeContext({ modelId: 'gpt-5', agentId: undefined });
      const result = await handleBeforeModelResolve({}, ctx, config, HELPER_PATH);

      assert.ok(result, 'bridge returns a projection');
      assert.equal(result.providerOverride, 'codex', 'provider projected to codex');
      assert.ok(
        result.modelOverride.startsWith('axonhub_openclaw_'),
        'model projected to qualified id',
      );
      assert.ok(result.modelOverride.endsWith('/gpt-5'), 'qualified id includes original model');

      // Verify the managed TOML block was written to the effective (CODEX_HOME) home.
      const configPath = path.join(tmpHome, 'config.toml');
      assert.ok(fs.existsSync(configPath), 'config.toml created');
      const tomlContent = fs.readFileSync(configPath, 'utf8');
      assert.ok(
        tomlContent.includes('axonhub-openclaw-plugin'),
        'managed block marker present',
      );
      assert.ok(tomlContent.includes('wire_api = "responses"'), 'responses endpoint configured');
      assert.match(tomlContent, /base_url = ".*\/v1"/, 'base_url routes to /v1');

      // The auth command must reference a generated wrapper, never the raw token.
      assert.ok(tomlContent.includes('command ='), 'auth command present');
      assert.ok(!tomlContent.includes(HELPER_PATH.replace(/\//g, '\\/')), 'no inline helper leak');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }

  // --- Idempotence: a second projection produces byte-identical TOML ---
  {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmpHome;
    try {
      const config = makeConfig({ baseUrl: undefined });
      const ctx = makeContext({ modelId: 'gpt-5', agentId: undefined });
      await handleBeforeModelResolve({}, ctx, config, HELPER_PATH);
      const configPath = path.join(tmpHome, 'config.toml');
      const first = fs.readFileSync(configPath, 'utf8');
      await handleBeforeModelResolve({}, ctx, config, HELPER_PATH);
      const second = fs.readFileSync(configPath, 'utf8');
      assert.equal(second, first, 'repeated projection is idempotent');
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }

  console.log('codex bridge projection OK');
});

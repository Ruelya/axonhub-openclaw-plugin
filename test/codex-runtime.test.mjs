import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Transpile the codex-runtime module in isolation and import it.
const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-codex-runtime-'));
for (const file of ['codex-runtime.ts']) {
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

const { resolveEffectiveRuntime, isCodexRuntimeIntended } = await import(
  pathToFileURL(path.join(out, 'codex-runtime.js'))
);

test('codex runtime intent resolution', () => {
  // --- No config → no explicit runtime ---
  assert.equal(
    resolveEffectiveRuntime({ config: undefined, agentId: undefined, modelId: 'gpt-5' }),
    undefined,
    'undefined config yields no runtime',
  );
  assert.equal(
    isCodexRuntimeIntended({ config: undefined, agentId: undefined, modelId: 'gpt-5' }),
    false,
  );

  // --- Session override wins (precedence 1) ---
  assert.equal(
    resolveEffectiveRuntime({
      config: undefined,
      agentId: undefined,
      modelId: 'gpt-5',
      sessionRuntimeOverride: 'codex',
    }),
    'codex',
    'session override wins even with no config',
  );

  // --- auto/default/openclaw normalize to undefined (not explicit) ---
  for (const noop of ['auto', 'default', 'openclaw', '']) {
    assert.equal(
      resolveEffectiveRuntime({
        config: undefined,
        agentId: undefined,
        modelId: 'gpt-5',
        sessionRuntimeOverride: noop,
      }),
      undefined,
      `${noop || '(empty)'} does not represent explicit selection`,
    );
  }

  // --- Provider-level agentRuntime (precedence 5) ---
  const providerRuntimeConfig = {
    models: { providers: { axonhub: { agentRuntime: { id: 'codex' } } } },
  };
  assert.equal(
    isCodexRuntimeIntended({ config: providerRuntimeConfig, agentId: undefined, modelId: 'gpt-5' }),
    true,
    'provider-level agentRuntime.id=codex triggers projection',
  );

  // --- Provider model entry (precedence 3) beats provider-level ---
  const providerModelConfig = {
    models: {
      providers: {
        axonhub: {
          agentRuntime: { id: 'openclaw' },
          models: [{ id: 'gpt-5', agentRuntime: { id: 'codex' } }],
        },
      },
    },
  };
  assert.equal(
    resolveEffectiveRuntime({ config: providerModelConfig, agentId: undefined, modelId: 'gpt-5' }),
    'codex',
    'provider model entry overrides provider-level runtime',
  );
  // A different model on the same provider falls back to provider-level (openclaw → undefined).
  assert.equal(
    resolveEffectiveRuntime({ config: providerModelConfig, agentId: undefined, modelId: 'other' }),
    undefined,
    'unlisted model falls back to provider-level openclaw (normalized undefined)',
  );

  // --- Agent exact model entry (precedence 2) is highest config tier ---
  const agentExactConfig = {
    agents: {
      list: [
        {
          id: 'main',
          models: { 'axonhub/gpt-5': { agentRuntime: { id: 'codex' } } },
        },
      ],
    },
    models: {
      providers: { axonhub: { agentRuntime: { id: 'openclaw' } } },
    },
  };
  assert.equal(
    resolveEffectiveRuntime({ config: agentExactConfig, agentId: 'main', modelId: 'gpt-5' }),
    'codex',
    'agent exact model entry wins over provider-level',
  );
  // Wrong agent id → falls back to provider-level.
  assert.equal(
    resolveEffectiveRuntime({ config: agentExactConfig, agentId: 'other', modelId: 'gpt-5' }),
    undefined,
    'non-matching agent id falls back to provider-level',
  );

  // --- Agent provider-wildcard entry (precedence 4) ---
  const agentWildcardConfig = {
    agents: {
      list: [{ id: 'main', models: { 'axonhub/*': { agentRuntime: { id: 'codex' } } } }],
    },
  };
  assert.equal(
    resolveEffectiveRuntime({ config: agentWildcardConfig, agentId: 'main', modelId: 'any-model' }),
    'codex',
    'agent provider-wildcard entry matches any model',
  );

  // --- Case-insensitive normalization ---
  assert.equal(
    resolveEffectiveRuntime({
      config: undefined,
      agentId: undefined,
      modelId: 'gpt-5',
      sessionRuntimeOverride: 'CODEX',
    }),
    'codex',
    'runtime id is lowercased',
  );

  console.log('codex runtime resolution OK');
});

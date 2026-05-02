import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-plugin-test-'));
for (const file of ['index.ts', 'onboard.ts', 'provider-catalog.ts']) {
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
let provider;
plugin.register({ registerProvider(value) { provider = value; } });
assert(provider, 'provider should be registered');

function levels(modelId, reasoning = true) {
  return provider.resolveThinkingProfile({ provider: 'axonhub', modelId, reasoning }).levels.map((entry) => entry.id);
}

assert.deepEqual(levels('deepseek-v4-flash'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('axonhub/deepseek-v4-pro'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('gpt-5.4'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
assert.deepEqual(levels('ordinary-reasoning-model'), ['off', 'minimal', 'low', 'medium', 'high']);
assert.equal(provider.resolveThinkingProfile({ provider: 'axonhub', modelId: 'plain-chat', reasoning: false }), null);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'deepseek-v4-flash' }), true);
assert.equal(provider.supportsXHighThinking({ provider: 'axonhub', modelId: 'plain-chat' }), false);

console.log('reasoning profile compatibility OK');

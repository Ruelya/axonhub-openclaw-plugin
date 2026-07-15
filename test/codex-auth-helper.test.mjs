import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-codex-auth-'));

// Transpile the standalone helper core. It only needs the SDK import, which is
// never exercised because tests inject the resolver via deps.
for (const file of ['codex-auth-helper.ts']) {
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

const { runCodexAuthHelper } = await import(
  pathToFileURL(path.join(out, 'codex-auth-helper.js'))
);

/** Build an injectable deps object capturing stdout/stderr. */
function makeDeps(resolveApiKey) {
  const stdout = [];
  const stderr = [];
  return {
    deps: {
      resolveApiKey,
      writeStdout: (t) => stdout.push(t),
      writeStderr: (t) => stderr.push(t),
    },
    stdout,
    stderr,
  };
}

test('codex auth helper', async () => {
  // --- Success: exactly the token + newline to stdout, nothing to stderr ---
  {
    const { deps, stdout, stderr } = makeDeps(async ({ provider, agentDir, profileId }) => {
      assert.equal(provider, 'axonhub');
      assert.equal(agentDir, '/agent-dir');
      assert.equal(profileId, undefined);
      return { apiKey: 'test-token-12345', profileId: 'axonhub:default' };
    });
    const code = await runCodexAuthHelper(['/agent-dir'], deps);
    assert.equal(code, 0, 'success exit code');
    assert.deepEqual(stdout, ['test-token-12345\n'], 'exactly the token + newline on stdout');
    assert.equal(stderr.length, 0, 'no stderr on success');
  }

  // --- Profile id is forwarded when provided ---
  {
    let seenProfile;
    const { deps, stdout } = makeDeps(async ({ profileId }) => {
      seenProfile = profileId;
      return { apiKey: 'tok' };
    });
    const code = await runCodexAuthHelper(['/agent-dir', 'work'], deps);
    assert.equal(code, 0);
    assert.equal(seenProfile, 'work', 'profileId forwarded to resolver');
    assert.deepEqual(stdout, ['tok\n']);
  }

  // --- Missing agentDir → usage error, non-zero, nothing on stdout ---
  {
    const { deps, stdout, stderr } = makeDeps(async () => ({ apiKey: 'tok' }));
    const code = await runCodexAuthHelper([], deps);
    assert.notEqual(code, 0, 'missing args exits non-zero');
    assert.equal(stdout.length, 0, 'no token leaked on usage error');
    assert.ok(stderr.join('').toLowerCase().includes('usage'), 'usage hint on stderr');
  }

  // --- No credential found → error on stderr, non-zero, no stdout ---
  {
    const { deps, stdout, stderr } = makeDeps(async () => ({ apiKey: undefined }));
    const code = await runCodexAuthHelper(['/agent-dir'], deps);
    assert.notEqual(code, 0, 'no key exits non-zero');
    assert.equal(stdout.length, 0, 'no stdout when key missing');
    assert.ok(stderr.join('').includes('No AxonHub API key'), 'diagnostic on stderr');
  }

  // --- Resolver throws → caught, error on stderr, non-zero, no token leak ---
  {
    const { deps, stdout, stderr } = makeDeps(async () => {
      throw new Error('credential lookup failed');
    });
    const code = await runCodexAuthHelper(['/agent-dir'], deps);
    assert.notEqual(code, 0, 'resolver failure exits non-zero');
    assert.equal(stdout.length, 0, 'no stdout on resolver failure');
    assert.ok(stderr.join('').includes('credential lookup failed'), 'error message on stderr');
  }

  // --- Too many args → usage error ---
  {
    const { deps, stderr } = makeDeps(async () => ({ apiKey: 'tok' }));
    const code = await runCodexAuthHelper(['a', 'b', 'c'], deps);
    assert.notEqual(code, 0, 'excess args exits non-zero');
    assert.ok(stderr.join('').toLowerCase().includes('usage'), 'usage hint on stderr');
  }

  fs.rmSync(out, { recursive: true, force: true });
  console.log('codex auth helper OK');
});

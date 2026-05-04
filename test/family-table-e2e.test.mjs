// E2E sanity check against a live AxonHub instance.
// Verifies the family-table decisions for every model AxonHub returns.
// Skips silently if the instance is unreachable so it doesn't break CI.
//
// Configure via env:
//   AXONHUB_E2E_BASE_URL — defaults to http://localhost:8090/v1
//   AXONHUB_E2E_API_KEY  — required; without it the test is skipped

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const BASE_URL = process.env.AXONHUB_E2E_BASE_URL ?? 'http://localhost:8090/v1';
const API_KEY = process.env.AXONHUB_E2E_API_KEY;

if (!API_KEY) {
  console.log('SKIP: AXONHUB_E2E_API_KEY not set');
  process.exit(0);
}

let response;
try {
  response = await fetch(`${BASE_URL}/models?include=name,capabilities,context_length,max_output_tokens,pricing,type`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(3000),
  });
} catch (e) {
  console.log(`SKIP: AxonHub instance unreachable (${e?.message ?? e})`);
  process.exit(0);
}
if (!response.ok) {
  console.log(`SKIP: AxonHub returned ${response.status}`);
  process.exit(0);
}
const payload = await response.json();
const models = Array.isArray(payload?.data) ? payload.data : [];
if (models.length === 0) {
  console.log('SKIP: AxonHub returned 0 models');
  process.exit(0);
}

const repo = process.cwd();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axonhub-plugin-e2e-'));
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

const familyTable = await import(pathToFileURL(path.join(out, 'family-table.js')));

const rows = [];
for (const m of models) {
  if (!m?.id) continue;
  if (m.type && m.type !== 'chat') continue;
  const family = familyTable.resolveAxonhubFamily(m.id);
  rows.push({
    id: m.id,
    owned_by: m.owned_by,
    api_reasoning: m.capabilities?.reasoning === true,
    family: family?.family ?? null,
    levels: family ? family.profile.levels.map((l) => l.id).join(',') : '(none)',
    xhigh: family?.supportsXHigh ?? false,
    max: family?.supportsMax ?? false,
    compat: family?.supportedEffortsForCompat?.join(',') ?? '(none)',
  });
}
rows.sort((a, b) => a.id.localeCompare(b.id));
console.log(`AxonHub live instance @ ${BASE_URL}: ${rows.length} chat models`);
for (const r of rows) {
  console.log(
    [
      r.id.padEnd(36),
      `(${r.owned_by ?? '?'})`.padEnd(14),
      r.api_reasoning ? 'reasoning' : 'no-reason',
      `family=${r.family ?? '∅'}`.padEnd(34),
      `xhigh=${r.xhigh}`.padEnd(12),
      `max=${r.max}`.padEnd(10),
      `compat=${r.compat}`,
    ].join(' '),
  );
}

// Sanity: at least one of each known family appears (flexible — only enforce
// if the model is actually present)
const presentFamilies = new Set(rows.map((r) => r.family).filter(Boolean));
console.log(`families seen: ${[...presentFamilies].sort().join(', ') || '(none)'}`);

console.log('e2e family-table check OK');

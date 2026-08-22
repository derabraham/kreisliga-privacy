import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(here, '..', '..');
const catalogPath = path.join(siteRoot, 'assets', 'data', 'player_pack_catalog.json');
const outDir = path.join(siteRoot, 'assets', 'player-packs');
const CONCURRENCY = 4;

const cleanName = value => String(value || '').replace(/[?#].*$/, '').split('/').pop() || '';
function fileNameFor(pack) {
  return cleanName(pack?.fileName) || cleanName(pack?.webPath) || cleanName(pack?.assetPath) || cleanName(pack?.url) || `${pack?.id || 'pack'}.json`;
}

async function readCatalog() {
  let raw;
  try { raw = await fs.readFile(catalogPath, 'utf8'); }
  catch (error) {
    throw new Error(`Catalog not found: ${catalogPath}. Merge the Database Studio into the full website repository first. (${error.message})`);
  }
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('player_pack_catalog.json must contain an array.');
  return data;
}

async function download(pack) {
  const url = String(pack?.url || '').trim();
  if (!url) throw new Error(`${pack?.name || pack?.id}: no download URL in catalog.`);
  const fileName = fileNameFor(pack);
  if (!/\.json$/i.test(fileName)) throw new Error(`${pack?.name || pack?.id}: expected a .json filename, got ${fileName}.`);
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'KFM-Database-Studio-Pages-Build' } });
  if (!response.ok) throw new Error(`${pack?.name || pack?.id}: HTTP ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 10) throw new Error(`${pack?.name || pack?.id}: downloaded file is empty.`);
  // Validate JSON before publishing a broken Pages artifact.
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.players)) throw new Error(`${pack?.name || pack?.id}: JSON has no players array.`);
  const dest = path.join(outDir, fileName);
  const temp = `${dest}.tmp`;
  await fs.writeFile(temp, bytes);
  await fs.rename(temp, dest);
  return { pack: pack?.name || pack?.id, fileName, players: parsed.players.length, bytes: bytes.byteLength };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = { ok: true, value: await worker(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, run));
  return results;
}

const catalog = await readCatalog();
await fs.mkdir(outDir, { recursive: true });
console.log(`KFM player-pack sync: ${catalog.length} catalog entries -> ${outDir}`);
const results = await mapLimit(catalog, CONCURRENCY, download);
let failed = 0;
for (let i = 0; i < results.length; i++) {
  const result = results[i];
  if (result.ok) {
    const x = result.value;
    console.log(`OK  ${x.fileName} · ${x.players} players · ${(x.bytes / 1024).toFixed(0)} KB`);
  } else {
    failed++;
    console.error(`ERR ${catalog[i]?.name || catalog[i]?.id || i}: ${result.error?.message || result.error}`);
  }
}
if (failed) {
  console.error(`Player-pack sync failed for ${failed}/${catalog.length} pack(s). Pages artifact was not fully prepared.`);
  process.exitCode = 1;
} else {
  console.log(`Player-pack sync complete: ${catalog.length}/${catalog.length} packs available same-origin.`);
}

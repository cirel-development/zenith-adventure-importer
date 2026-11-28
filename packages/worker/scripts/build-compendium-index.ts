/**
 * Build packages/worker/data/compendium-index.json from a pinned PF2e release.
 *
 * Source: the release's json-assets.zip (packs/<folder>.json, one array of
 * complete documents per pack) plus its system.json (pack folder -> pack
 * name/label/type). One download per PF2e version, no GitHub API calls.
 *
 * UUIDs use the pack NAME from system.json, which is not always the folder:
 *   folder "equipment" -> name "equipment-srd"  -> Compendium.pf2e.equipment-srd.Item.<_id>
 *   folder "fall-of-plaguestone" -> "fall-of-plaguestone-bestiary"
 *
 * Run:  pnpm --filter @ai-adventure/worker build:index [-- --version 8.7.2] [-- --refresh]
 * Output is deterministic for a given PF2e version (sorted, no timestamps).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import {
  INDEX_ENTRY_FIELDS,
  ITEM_PACKS,
  PREGEN_PACKS,
  packTier,
  type CompendiumIndexFile,
  type IndexEntry,
  type IndexPack,
} from '../src/compendium/indexTypes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, '..');
const OUT = join(WORKER, 'data', 'compendium-index.json');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function download(url: string, dest: string): Promise<void> {
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
}

interface SystemPack {
  name: string;
  label: string;
  type: string;
  path: string;
}

async function main(): Promise<void> {
  const version = arg('version') ?? '8.7.2';
  const refresh = process.argv.includes('--refresh');
  const tag = `pf2e-${version}`;
  const base = `https://github.com/foundryvtt/pf2e/releases/download/${tag}`;
  const cache = join(WORKER, '.cache', tag);
  await mkdir(cache, { recursive: true });

  const zipPath = join(cache, 'json-assets.zip');
  const sysPath = join(cache, 'system.json');
  if (refresh || !existsSync(sysPath)) await download(`${base}/system.json`, sysPath);
  if (refresh || !existsSync(zipPath)) await download(`${base}/json-assets.zip`, zipPath);

  const system = JSON.parse(await readFile(sysPath, 'utf8')) as {
    id: string;
    version: string;
    compatibility: { minimum: string; verified: string; maximum?: string };
    packs: SystemPack[];
  };
  if (system.version !== version) throw new Error(`system.json is ${system.version}, expected ${version}`);

  // Scope (decided 2026-11-27): every Actor pack + equipment, spells, feats, conditions.
  const wanted = system.packs.filter((p) => p.type === 'Actor' || ITEM_PACKS.includes(p.name));
  const byFolder = new Map(wanted.map((p) => [posix.basename(p.path), p]));

  console.log(`[index] ${tag}: ${wanted.length} packs`);
  const files = unzipSync(new Uint8Array(await readFile(zipPath)), {
    filter: (f) => {
      const m = /^packs\/([^/]+?)(_folders)?\.json$/.exec(f.name);
      return !!m && byFolder.has(m[1]!) && (!m[2] || PREGEN_PACKS.includes(byFolder.get(m[1]!)!.name));
    },
  });

  const packs: IndexPack[] = [];
  const entries: IndexEntry[] = [];
  const pregenFolders: Record<string, string> = {};
  const missing: string[] = [];

  const sortedPacks = [...wanted].sort((a, b) => a.name.localeCompare(b.name));
  for (const sp of sortedPacks) {
    const folder = posix.basename(sp.path);
    const file = files[`packs/${folder}.json`];
    if (!file) {
      missing.push(`${sp.name} (packs/${folder}.json)`);
      continue;
    }
    const docs = JSON.parse(strFromU8(file)) as any[];
    const packIdx = packs.length;
    packs.push({
      name: sp.name,
      label: sp.label,
      docType: sp.type as 'Actor' | 'Item',
      folder,
      count: docs.length,
      tier: packTier(sp.name, sp.type),
    });
    const folderFile = PREGEN_PACKS.includes(sp.name) ? files[`packs/${folder}_folders.json`] : undefined;
    const folderNames = new Map<string, string>(
      folderFile ? (JSON.parse(strFromU8(folderFile)) as any[]).map((f) => [f._id as string, f.name as string]) : [],
    );
    for (const d of docs) {
      if (typeof d?._id !== 'string' || typeof d?.name !== 'string') continue;
      const folderName = d.folder ? folderNames.get(d.folder) : undefined;
      if (folderName) pregenFolders[`${sp.name}/${d._id}`] = folderName;
      const level = d.system?.details?.level?.value ?? d.system?.level?.value ?? null;
      const rarity = d.system?.traits?.rarity ?? null;
      entries.push([d.name, d._id, packIdx, d.type, typeof level === 'number' ? level : null, rarity]);
    }
  }
  if (missing.length) throw new Error(`packs listed in system.json but absent from json-assets.zip:\n  ${missing.join('\n  ')}`);

  entries.sort((a, b) => a[2] - b[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  const out: CompendiumIndexFile = {
    source: {
      system: system.id,
      version: system.version,
      release: `https://github.com/foundryvtt/pf2e/releases/tag/${tag}`,
      foundry: system.compatibility,
    },
    entryFields: [...INDEX_ENTRY_FIELDS],
    packs,
    entries,
    pregenFolders: Object.fromEntries(Object.entries(pregenFolders).sort(([a], [b]) => a.localeCompare(b))),
  };

  await mkdir(dirname(OUT), { recursive: true });
  // One entry per line: readable diffs between PF2e versions, modest size.
  const body =
    '{\n' +
    `  "source": ${JSON.stringify(out.source)},\n` +
    `  "entryFields": ${JSON.stringify(out.entryFields)},\n` +
    `  "packs": [\n${packs.map((p) => '    ' + JSON.stringify(p)).join(',\n')}\n  ],\n` +
    `  "pregenFolders": ${JSON.stringify(out.pregenFolders)},\n` +
    `  "entries": [\n${entries.map((e) => '    ' + JSON.stringify(e)).join(',\n')}\n  ]\n}\n`;
  await writeFile(OUT, body, 'utf8');

  const actorCount = entries.filter((e) => packs[e[2]]!.docType === 'Actor').length;
  console.log(`[index] wrote ${OUT}`);
  console.log(`        ${packs.length} packs, ${entries.length} entries (${actorCount} actors, ${entries.length - actorCount} items), ${(Buffer.byteLength(body) / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

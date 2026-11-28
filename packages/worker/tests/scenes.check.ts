/**
 * Offline checks for Phase 3 scene building (maps/scenes.ts, maps/pipeline.ts,
 * maps/vision.ts). Synthetic images only — no book images in this public repo.
 * Run: pnpm --filter @ai-adventure/worker test:scenes
 */
import { validateBundle } from '@ai-adventure/contract';
import { buildScenes, snapToGrid, snapWallsToInk, SCENE_CELL, type LocationRef } from '../src/maps/scenes.js';
import { downscale, panelGrid, scaleAnswer } from '../src/maps/pipeline.js';
import { buildVisionMessage, parseVisionAnswer, type VisionAnswer } from '../src/maps/vision.js';
import { detectGrid } from '../src/maps/grid.js';
import type { PdfImage } from '../src/pdf/images.js';
import { assembleBundle } from '../src/bundle/assemble.js';
import { ExtractedAdventureZ } from '../src/pipeline/extractAdventure.js';

const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  console.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `: expected ${e}, got ${a}`}`);
  if (!pass) failures.push(name);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Grey image with dark 1-px grid lines; `lineAt(x)`/`lineAt(y)` decides where. */
function gridImage(w: number, h: number, isLine: (x: number, y: number) => boolean, id = 'syn'): PdfImage {
  const rgba = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = isLine(x, y) ? 60 : 170 + Math.floor(rnd() * 30);
      const i = (y * w + x) * 4;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  return { id, page: 3, width: w, height: h, rgba };
}

// --- A sheet with two maps stacked: 40 px grid, top offset 10, bottom offset 25,
//     a solid white divider bar at y=400..420.
const sheet = gridImage(800, 820, (x, y) => {
  if (y >= 400 && y < 420) return false;
  const oy = y < 400 ? 10 : 25;
  return (x - 10) % 40 === 0 || (y - oy) % 40 === 0;
});
for (let y = 400; y < 420; y++) for (let x = 0; x < 800; x++) sheet.rgba.fill(255, (y * 800 + x) * 4, (y * 800 + x) * 4 + 3);

const top = detectGrid(sheet);
check('whole sheet: a grid is found or the panels give one', !!(top ?? panelGrid(sheet)), true);

const snapTop = snapToGrid(sheet, { x: 0, y: 0, width: 800, height: 395 }, top ?? panelGrid(sheet)!);
check('snap top map to its grid lines', snapTop && [Math.round(snapTop.rect.x), Math.round(snapTop.rect.y), snapTop.cols, snapTop.rows], [10, 10, 19, 9]);
const snapBottom = snapToGrid(sheet, { x: 0, y: 425, width: 800, height: 395 }, top ?? panelGrid(sheet)!);
check('snap bottom map uses its own phase (offset 25)', snapBottom && [near(snapBottom.rect.y, 425, 1.5), snapBottom.rows], [true, 9]);

// --- buildScenes from a vision answer: two maps, walls, a light, pins.
const locations: LocationRef[] = [
  { area_code: 'A1', name: 'Gatehouse', journalSlug: 'ch-1-keep', pageSlug: 'a1', chapterSlug: 'keep' },
  { area_code: null, name: 'Courtyard', journalSlug: 'ch-1-keep', pageSlug: 'courtyard', chapterSlug: 'keep' },
];
const answer: VisionAnswer = parseVisionAnswer({
  is_map: true,
  reason: 'two maps',
  maps: [
    {
      name: 'Gatehouse',
      area_codes: ['A1'],
      region: { x: 0, y: 0, width: 800, height: 395 },
      walls: [
        { x1: 90, y1: 50, x2: 410, y2: 50, kind: 'wall' },
        { x1: 410, y1: 50, x2: 410, y2: 50, kind: 'wall' },
        { x1: 250, y1: 50, x2: 250, y2: 130, kind: 'door' },
        { x1: 90, y1: 130, x2: 170, y2: 130, kind: 'window' },
      ],
      lights: [{ x: 210, y: 90, bright_cells: 2, dim_cells: 4, kind: 'torch' }],
      pins: [
        { label: 'A1', x: 130, y: 90 },
        { label: 'S', x: 300, y: 300 },
      ],
    },
    { name: 'Courtyard', region: { x: 0, y: 425, width: 800, height: 395 }, walls: [], lights: [], pins: [] },
  ],
});
let n = 0;
const built = buildScenes([{ image: sheet, grid: (top ?? panelGrid(sheet))!, vision: answer }], {
  slug: (s) => `${s.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n++}`,
  folderFor: (ch) => `adv-scenes/${ch ?? 'overview'}-scene`,
  locations,
});
check('two scenes from one image', built.scenes.map((s) => s.name), ['Gatehouse', 'Courtyard']);
check('two jpeg assets', [...built.assets.keys()].every((k) => /^images\/maps\/[a-z0-9-]+\.jpg$/.test(k)) && built.assets.size === 2, true);
check('jpeg bytes start with FFD8', [...built.assets.values()].every((b) => b[0] === 0xff && b[1] === 0xd8), true);
const g = built.scenes[0]!;
check('scene size is whole cells at 100 px', [g.grid.size, g.dimensions.width % SCENE_CELL, g.dimensions.height % SCENE_CELL], [100, 0, 0]);
check('zero-length wall dropped', g.walls.length, 3);
check('door and window kinds', g.walls.map((w) => [w.door, w.sight]), [[0, 20], [1, 20], [0, 0]]);
const w0 = g.walls[0]!.c;
check('wall normalized to the crop (x 90 -> (90-10)/760)', [near(w0[0], 80 / 760, 0.01), near(w0[1], 40 / 360, 0.01)], [true, true]);
check('torch light animated, dim >= bright', [g.lights[0]!.config.animation?.type, g.lights[0]!.config.dim, g.lights[0]!.config.bright], ['torch', 4, 2]);
check('pin linked to A1, unmatched "S" dropped', g.notes.map((p) => [p.label, p.journal_ref]), [['A1', '[[REF:journal:ch-1-keep#a1]]']]);
check('folder from the matched area code', g.folder, 'adv-scenes/keep-scene');
check('folder from the location name when no code', built.scenes[1]!.folder, 'adv-scenes/keep-scene');
check('review flagged', g.ai_metadata?.review_required, true);

// --- Ink snapping: a light image with a dark drawn wall (6 px band at y=100,
//     x 50..350) and a dark vertical wall at x=350 (y 100..300).
const ink = gridImage(400, 400, () => false, 'ink');
const paint = (x0: number, y0: number, x1: number, y1: number) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ink.rgba.fill(25, (y * 400 + x) * 4, (y * 400 + x) * 4 + 3);
};
paint(50, 97, 353, 103);
paint(347, 97, 353, 300);
const inked = snapWallsToInk(
  [
    { x1: 50, y1: 112, x2: 338, y2: 112, kind: 'wall' }, // traced 12 px below the drawn wall
    { x1: 338, y1: 112, x2: 338, y2: 300, kind: 'wall' }, // traced 12 px left, shares the corner
    { x1: 60, y1: 200, x2: 140, y2: 280, kind: 'wall' }, // diagonal: unchanged
    { x1: 60, y1: 360, x2: 200, y2: 360, kind: 'wall' }, // no ink nearby: unchanged
  ],
  ink,
  40,
);
check('horizontal wall moves onto the drawn ink', near(inked[0]!.y1, 100, 2) && inked[0]!.y1 === inked[0]!.y2, true);
check('vertical wall moves onto the drawn ink', near(inked[1]!.x1, 350, 2) && inked[1]!.x1 === inked[1]!.x2, true);
check('shared corner stays closed', [inked[0]!.x2 === inked[1]!.x1, inked[0]!.y2 === inked[1]!.y1], [true, true]);
check('diagonal keeps its trace', [inked[2]!.x1, inked[2]!.y1, inked[2]!.x2, inked[2]!.y2], [60, 200, 140, 280]);
check('no darker line nearby: wall stays', inked[3]!.y1, 360);

// --- No vision answer: one map-only scene of the whole image; non-map answer: none.
const solo = gridImage(400, 400, (x, y) => (x - 5) % 40 === 0 || (y - 5) % 40 === 0, 'solo');
const soloGrid = detectGrid(solo)!;
const mapOnly = buildScenes([{ image: solo, grid: soloGrid }], { slug: (s) => s, folderFor: () => 'f/o', locations: [] });
check('no vision -> one map-only scene', [mapOnly.scenes.length, mapOnly.scenes[0]?.walls.length, mapOnly.scenes[0]?.ai_metadata?.prompt_version], [1, 0, 'maps-grid-only-1']);
const notMap = buildScenes([{ image: solo, grid: soloGrid, vision: parseVisionAnswer({ is_map: false, reason: 'art', maps: [] }) }], { slug: (s) => s, folderFor: () => 'f/o', locations: [] });
check('is_map false -> no scene', notMap.scenes.length, 0);

// --- Vision helpers.
const big: PdfImage = { id: 'big', page: 1, width: 3136, height: 1000, rgba: new Uint8ClampedArray(3136 * 1000 * 4) };
const ds = downscale(big, 1568);
check('downscale to the vision limit', [ds.image.width, ds.image.height, ds.scale], [1568, 500, 0.5]);
const scaled = scaleAnswer(answer, 0.5);
check('scaleAnswer maps sent pixels back', [scaled.maps[0]!.region.width, scaled.maps[0]!.walls[0]!.x1, scaled.maps[0]!.pins[0]!.x], [1600, 180, 260]);
check('vision message names grid and locations', /cells of 40\.0 px/.test(buildVisionMessage({ imageId: 'x', page: 2, width: 10, height: 10, grid: { cellPx: 40, offsetX: 1, offsetY: 2 }, locations: [{ area_code: 'A1', name: 'Gatehouse', chapter: 'Keep' }], pageText: 'p' })), true);
check('malformed answer rejected', (() => { try { parseVisionAnswer({ is_map: true, maps: [{ name: 'x' }] }); return false; } catch { return true; } })(), true);

// --- panelGrid: a sheet whose panels have different phases; a plain single grid is not a sheet.
const panels = gridImage(820, 400, (x, y) => (x >= 400 && x < 420 ? false : x < 400 ? (x - 3) % 38 === 0 || (y - 3) % 38 === 0 : (x - 431) % 38 === 0 || (y - 20) % 38 === 0));
for (let y = 0; y < 400; y++) for (let x = 400; x < 420; x++) panels.rgba.fill(20, (y * 820 + x) * 4, (y * 820 + x) * 4 + 3);
const pg = panelGrid(panels);
check('panel sheet -> a panel grid near 38 px', pg && near(pg.cellPx, 38, 1), true);
check('single grid image is not a panel sheet', panelGrid(solo), null);

// --- assembleBundle wiring: scenes, scene folders, assets out, valid bundle.
const extracted = ExtractedAdventureZ.parse({
  title: 'Test Keep',
  synopsis: 's',
  chapters: [{ name: 'Keep', slug: 'keep', summary: 'c', locations: [{ name: 'Gatehouse', area_code: 'A1', description: 'd' }, { name: 'Courtyard', description: 'd' }] }],
});
const assets = new Map<string, Uint8Array>();
const bundle = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]), maps: [{ image: sheet, grid: (top ?? panelGrid(sheet))!, vision: answer }], assetsOut: assets });
check('bundle validates with scenes', validateBundle(bundle).valid, true);
check('bundle scenes + scene folders', [bundle.scenes.entities.length, bundle.folders.entities.filter((f) => f.type === 'scene').length], [2, 2]);
check('assets handed back for the zip', assets.size, 2);
check('pin links the real location page', bundle.scenes.entities[0]!.notes[0]?.journal_ref.startsWith('[[REF:journal:ch-1-keep#'), true);
const noMaps = assembleBundle(extracted, { pdfBytes: new Uint8Array([1]) });
check('no maps -> no scene folders', noMaps.folders.entities.some((f) => f.type === 'scene'), false);

if (failures.length) {
  console.error(`\n${failures.length} scene check(s) failed`);
  process.exit(1);
}
console.log('\nAll scene checks passed');

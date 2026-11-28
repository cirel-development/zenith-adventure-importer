/**
 * Phase 3: battle-map candidates (+ their vision answers) -> contract scenes
 * and the JPEG assets they reference.
 *
 * Each map is cropped on its own grid lines (grid detected inside the map's
 * region, so the two halves of a combined image keep their own phase) and
 * the scene is scaled so one cell is 100 px: grid size 100 in Foundry with
 * the image filling the scene exactly, whatever the printed resolution.
 * Walls, lights and pins arrive in image pixels and are stored normalized
 * to the crop (the contract's 0..1 coordinates).
 */
import type { Bundle } from '@ai-adventure/contract';
import { cropImage, encodeJpeg, type PdfImage } from '../pdf/images.js';
import { detectGrid, type GridFit } from './grid.js';
import type { VisionAnswer, VisionMap } from './vision.js';

type SceneEntry = Bundle['scenes']['entities'][number];
type Wall = SceneEntry['walls'][number];

export interface MapCandidate {
  image: PdfImage;
  grid: GridFit;
  /** Undefined: no vision answer (map-only scene of the whole image). */
  vision?: VisionAnswer;
}

export interface LocationRef {
  area_code: string | null;
  name: string;
  journalSlug: string;
  pageSlug: string;
  chapterSlug: string | null;
}

export interface SceneBuildContext {
  slug: (base: string) => string;
  folderFor: (chapterSlug: string | null) => string;
  locations: LocationRef[];
}

export interface SceneBuildResult {
  scenes: SceneEntry[];
  assets: Map<string, Uint8Array>;
  warnings: string[];
}

/** Foundry grid size for every scene; the image is scaled to it. */
export const SCENE_CELL = 100;

const WALL_KIND: Record<VisionMap['walls'][number]['kind'], Omit<Wall, 'c'>> = {
  wall: { light: 20, move: 20, sight: 20, door: 0, ds: 0 },
  door: { light: 20, move: 20, sight: 20, door: 1, ds: 0 },
  secret_door: { light: 20, move: 20, sight: 20, door: 2, ds: 0 },
  window: { light: 0, move: 20, sight: 0, door: 0, ds: 0 },
  terrain: { light: 0, move: 20, sight: 0, door: 0, ds: 0 },
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const assetSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'map';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The region snapped to whole grid cells: starts on a grid line, spans an
 * integer number of cells. Uses the grid found inside the region when there
 * is one (its own phase), else the whole image's grid.
 */
export function snapToGrid(image: PdfImage, region: Rect, fallback: GridFit): { rect: Rect; cols: number; rows: number; cell: number } | null {
  const r = {
    x: Math.max(0, Math.round(region.x)),
    y: Math.max(0, Math.round(region.y)),
    width: 0,
    height: 0,
  };
  r.width = Math.min(image.width - r.x, Math.round(region.width));
  r.height = Math.min(image.height - r.y, Math.round(region.height));
  if (r.width < 4 || r.height < 4) return null;

  const local = detectGrid(cropImage(image, r.x, r.y, r.width, r.height));
  const cell = local?.cellPx ?? fallback.cellPx;
  // First grid line inside the region, from the local fit or the global phase.
  const phase = (global: number, start: number) => ((((global - start) % cell) + cell) % cell);
  // A line right at the crop edge can come back as an offset of ~one cell
  // (phase wrap); treat it as 0 so the first row/column isn't lost.
  const unwrap = (o: number) => (o > cell - 2 ? Math.max(0, o - cell) : o);
  const x0 = unwrap(local ? local.offsetX : phase(fallback.offsetX, r.x));
  const y0 = unwrap(local ? local.offsetY : phase(fallback.offsetY, r.y));
  const cols = Math.floor((r.width - x0) / cell + 0.02);
  const rows = Math.floor((r.height - y0) / cell + 0.02);
  if (cols < 2 || rows < 2) return null;
  return {
    rect: { x: r.x + x0, y: r.y + y0, width: cols * cell, height: rows * cell },
    cols,
    rows,
    cell,
  };
}

/**
 * Move traced straight walls onto the drawn wall: vision traces land a
 * fraction of a cell off, and printed maps don't reliably draw walls on grid
 * lines, so the image itself decides. For each horizontal (vertical) wall,
 * search up to ~half a cell above/below (left/right) for the darkest band
 * along the wall's length and move the wall there, when that band is clearly
 * darker than where the trace put it. Corners shared by walls move together
 * (each point takes its y from its horizontal wall, its x from its vertical
 * one); diagonal and irregular walls (caves) keep their traced shape.
 */
export function snapWallsToInk(
  walls: VisionMap['walls'],
  image: { width: number; height: number; rgba: Uint8ClampedArray },
  cell: number,
): VisionMap['walls'] {
  const lum = (x: number, y: number) => {
    const xi = Math.max(0, Math.min(image.width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(image.height - 1, Math.round(y)));
    const o = (yi * image.width + xi) * 4;
    return 0.299 * image.rgba[o]! + 0.587 * image.rgba[o + 1]! + 0.114 * image.rgba[o + 2]!;
  };
  /** Mean luminance of a thin band along the wall, offset by `d` across it. */
  const band = (w: VisionMap['walls'][number], horizontal: boolean, d: number) => {
    const [a, b] = horizontal ? [Math.min(w.x1, w.x2), Math.max(w.x1, w.x2)] : [Math.min(w.y1, w.y2), Math.max(w.y1, w.y2)];
    const at = horizontal ? (w.y1 + w.y2) / 2 : (w.x1 + w.x2) / 2;
    // Skip the ends (corners belong to the crossing wall too).
    const from = a + (b - a) * 0.15;
    const to = b - (b - a) * 0.15;
    const steps = Math.max(4, Math.min(80, Math.round((to - from) / 2)));
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
      const s = from + ((to - from) * i) / steps;
      for (const t of [-1, 0, 1]) sum += horizontal ? lum(s, at + d + t) : lum(at + d + t, s);
    }
    return sum / ((steps + 1) * 3);
  };
  const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  const moveY = new Map<string, number>();
  const moveX = new Map<string, number>();
  const reach = Math.round(cell * 0.5);
  for (const w of walls) {
    const dx = Math.abs(w.x2 - w.x1);
    const dy = Math.abs(w.y2 - w.y1);
    const horizontal = dy <= 0.18 * dx;
    const vertical = dx <= 0.18 * dy;
    if ((!horizontal && !vertical) || Math.max(dx, dy) < cell * 0.6) continue;
    const here = band(w, horizontal, 0);
    let best = 0;
    let bestLum = here;
    for (let d = -reach; d <= reach; d++) {
      const l = band(w, horizontal, d);
      if (l < bestLum) {
        bestLum = l;
        best = d;
      }
    }
    // Only move for a clearly darker line (drawn walls are dark ink).
    if (best === 0 || here - bestLum < 18) continue;
    const target = horizontal ? (w.y1 + w.y2) / 2 + best : (w.x1 + w.x2) / 2 + best;
    for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]] as const) (horizontal ? moveY : moveX).set(key(x, y), target);
  }
  return walls.map((w) => ({
    ...w,
    x1: moveX.get(key(w.x1, w.y1)) ?? w.x1,
    y1: moveY.get(key(w.x1, w.y1)) ?? w.y1,
    x2: moveX.get(key(w.x2, w.y2)) ?? w.x2,
    y2: moveY.get(key(w.x2, w.y2)) ?? w.y2,
  }));
}

export function buildScenes(candidates: MapCandidate[], ctx: SceneBuildContext): SceneBuildResult {
  const scenes: SceneEntry[] = [];
  const assets = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  const byCode = new Map(ctx.locations.filter((l) => l.area_code).map((l) => [l.area_code!.toLowerCase(), l]));

  for (const cand of candidates) {
    const { image } = cand;
    const maps: VisionMap[] = cand.vision
      ? cand.vision.is_map
        ? cand.vision.maps
        : []
      : [{ name: `Map (page ${image.page})`, area_codes: [], region: { x: 0, y: 0, width: image.width, height: image.height }, walls: [], lights: [], pins: [] }];

    for (const m of maps) {
      const snapped = snapToGrid(image, m.region, cand.grid);
      if (!snapped) {
        warnings.push(`Map "${m.name}" (page ${image.page}) was too small to place on a grid; skipped.`);
        continue;
      }
      const { rect, cols, rows } = snapped;
      const slug = ctx.slug(`scene-${m.name}`);
      const asset = `images/maps/${assetSlug(slug)}.jpg`;
      assets.set(asset, encodeJpeg(cropImage(image, rect.x, rect.y, rect.width, rect.height), 85));

      const nx = (x: number) => clamp01((x - rect.x) / rect.width);
      const ny = (y: number) => clamp01((y - rect.y) / rect.height);

      const walls: Wall[] = snapWallsToInk(m.walls, image, snapped.cell)
        .map((w) => ({ c: [nx(w.x1), ny(w.y1), nx(w.x2), ny(w.y2)] as Wall['c'], ...WALL_KIND[w.kind] }))
        .filter((w) => Math.hypot((w.c[2] - w.c[0]) * cols, (w.c[3] - w.c[1]) * rows) > 0.05);

      const lights: SceneEntry['lights'] = m.lights.map((l) => ({
        x: nx(l.x),
        y: ny(l.y),
        config: {
          bright: l.bright_cells,
          dim: Math.max(l.dim_cells, l.bright_cells),
          color: l.color ?? (l.kind === 'magic' ? '#8fb3ff' : '#ff9329'),
          alpha: 0.5,
          ...(l.kind === 'fire' || l.kind === 'torch' ? { animation: { type: 'torch' as const, speed: 3, intensity: 3 } } : {}),
        },
      }));

      // A pin links to the location its label (or its stated area code) names.
      const notes: SceneEntry['notes'] = [];
      const codes = new Set(m.area_codes.map((c) => c.toLowerCase()));
      for (const p of m.pins) {
        const loc = byCode.get((p.area_code ?? p.label).toLowerCase());
        if (!loc) continue;
        notes.push({ x: nx(p.x), y: ny(p.y), journal_ref: `[[REF:journal:${loc.journalSlug}#${loc.pageSlug}]]`, icon: 'icons/svg/book.svg', icon_size: 40, label: p.label });
        codes.add(loc.area_code!.toLowerCase());
      }
      // Chapter for the scene folder: a matched area code, else a location
      // with the map's name ("Harvester's Camp" in a book without area codes).
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const first =
        [...codes].map((c) => byCode.get(c)).find(Boolean) ?? ctx.locations.find((l) => norm(l.name) === norm(m.name));

      scenes.push({
        slug,
        name: m.name,
        folder: ctx.folderFor(first?.chapterSlug ?? null),
        background: asset,
        dimensions: { width: cols * SCENE_CELL, height: rows * SCENE_CELL, padding: 0.25 },
        grid: { type: 'square', size: SCENE_CELL },
        walls,
        lights,
        sounds: [],
        notes,
        ai_metadata: {
          confidence: cand.vision ? 0.7 : 0.5,
          extracted_at: new Date().toISOString(),
          prompt_version: cand.vision ? 'maps-vision-1' : 'maps-grid-only-1',
          review_required: true,
          review_reasons: [
            cand.vision
              ? `Walls, doors and lights were traced from the map image (${walls.length} walls, ${lights.length} lights); check them before play.`
              : 'Map only: no walls or lights yet. Draw walls before play.',
          ],
        },
      });
    }
  }
  return { scenes, assets, warnings };
}

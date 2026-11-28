/**
 * Phase 3 glue: PDF -> battle-map candidates -> vision requests/answers.
 *
 *   findMapCandidates   images with a detected grid (maps/grid.ts)
 *   visionRequestFor    the image as sent (scaled to the vision limit) + its
 *                       context message (page text, locations, grid)
 *   runMapVision        production: one Claude call per candidate
 *   scaleAnswer         answers come back in sent-image pixels; scale them
 *                       to the original image before maps/scenes.ts
 *
 * Testing never calls the API: sim.ts writes the same requests to disk for a
 * stand-in model and reads its answers back through parseVisionAnswer.
 */
import type { AiClient } from '../ai/client.js';
import { cropImage, encodeJpeg, extractPdfImages, type PdfImage } from '../pdf/images.js';
import { detectGrid, type GridFit } from './grid.js';
import {
  buildVisionMessage,
  pageContext,
  parseVisionAnswer,
  VISION_SYSTEM,
  VISION_TOOL_NAME,
  VISION_TOOL_SCHEMA,
  type MapContext,
  type VisionAnswer,
} from './vision.js';
import type { MapCandidate } from './scenes.js';

/** Claude's vision input is resized past ~1568 px on the long side; send at most that. */
export const VISION_MAX_SIDE = 1568;

export interface Candidate {
  image: PdfImage;
  grid: GridFit;
}

export async function findMapCandidates(pdfBytes: Uint8Array): Promise<Candidate[]> {
  const images = await extractPdfImages(pdfBytes, { minSide: 400 });
  const out: Candidate[] = [];
  for (const image of images) {
    const grid = detectGrid(image) ?? panelGrid(image);
    if (grid) out.push({ image, grid });
  }
  return out;
}

interface Span {
  start: number;
  end: number;
}

/**
 * Runs of near-uniform rows (or columns) at least `minBar` thick: the bars
 * between panels on a multi-map sheet. Uniform = low luminance spread along
 * the line.
 */
function separatorRuns(img: PdfImage, rect: { x: number; y: number; width: number; height: number }, axis: 'rows' | 'cols', minBar = 4): Span[] {
  const len = axis === 'rows' ? rect.height : rect.width;
  const across = axis === 'rows' ? rect.width : rect.height;
  const flat: boolean[] = [];
  for (let i = 0; i < len; i++) {
    let sum = 0;
    let sq = 0;
    const step = Math.max(1, Math.floor(across / 400));
    let n = 0;
    for (let j = 0; j < across; j += step) {
      const x = axis === 'rows' ? rect.x + j : rect.x + i;
      const y = axis === 'rows' ? rect.y + i : rect.y + j;
      const o = (y * img.width + x) * 4;
      const l = 0.299 * img.rgba[o]! + 0.587 * img.rgba[o + 1]! + 0.114 * img.rgba[o + 2]!;
      sum += l;
      sq += l * l;
      n++;
    }
    const mean = sum / n;
    flat.push(sq / n - mean * mean < 60);
  }
  const runs: Span[] = [];
  for (let i = 0; i < len; ) {
    if (!flat[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < len && flat[j]) j++;
    if (j - i >= minBar) runs.push({ start: i, end: j });
    i = j;
  }
  return runs;
}

/** Cut a span into the pieces between separator runs, dropping slivers. */
function piecesBetween(len: number, runs: Span[], minSide: number): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const r of [...runs, { start: len, end: len }]) {
    if (r.start - at >= minSide) out.push({ start: at, end: r.start });
    at = r.end;
  }
  return out;
}

/**
 * A sheet of several maps divided by bars (each with its own grid phase, so
 * the whole image shows no single grid): split into panels, rows first then
 * columns within each row, and report the strongest panel grid, re-expressed
 * in the image's coordinates. Vision then separates the maps; maps/scenes.ts
 * re-detects each one's own grid.
 */
export function panelGrid(img: PdfImage, minSide = 250): GridFit | null {
  const whole = { x: 0, y: 0, width: img.width, height: img.height };
  const bands = piecesBetween(img.height, separatorRuns(img, whole, 'rows'), minSide);
  if (bands.length === 0) return null;
  let best: GridFit | null = null;
  let panels = 0;
  for (const band of bands) {
    const bandRect = { x: 0, y: band.start, width: img.width, height: band.end - band.start };
    for (const col of piecesBetween(img.width, separatorRuns(img, bandRect, 'cols'), minSide)) {
      panels++;
      const rect = { x: col.start, y: band.start, width: col.end - col.start, height: band.end - band.start };
      const fit = detectGrid(cropImage(img, rect.x, rect.y, rect.width, rect.height));
      if (fit && (!best || fit.score > best.score)) {
        best = {
          ...fit,
          offsetX: (rect.x + fit.offsetX) % fit.cellPx,
          offsetY: (rect.y + fit.offsetY) % fit.cellPx,
          cols: Math.floor(img.width / fit.cellPx),
          rows: Math.floor(img.height / fit.cellPx),
        };
      }
    }
  }
  // A single "panel" is the whole image again: no sheet to split.
  return panels > 1 ? best : null;
}

/** Box-filter downscale so the longer side is at most maxSide. Returns the factor used. */
export function downscale(img: PdfImage, maxSide: number): { image: PdfImage; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return { image: img, scale };
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.rgba[i]!; g += img.rgba[i + 1]!; b += img.rgba[i + 2]!; a += img.rgba[i + 3]!; n++;
        }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { image: { ...img, width: w, height: h, rgba: out }, scale: w / img.width };
}

export interface VisionRequest {
  imageId: string;
  /** Sent-image pixels = original pixels * scale. */
  scale: number;
  jpeg: Uint8Array;
  message: string;
}

export function visionRequestFor(
  cand: Candidate,
  pages: string[],
  locations: MapContext['locations'],
): VisionRequest {
  const { image: sent, scale } = downscale(cand.image, VISION_MAX_SIDE);
  const ctx: MapContext = {
    imageId: cand.image.id,
    page: cand.image.page,
    width: sent.width,
    height: sent.height,
    grid: { cellPx: cand.grid.cellPx * scale, offsetX: cand.grid.offsetX * scale, offsetY: cand.grid.offsetY * scale },
    locations,
    pageText: pageContext(pages, cand.image.page),
  };
  return { imageId: cand.image.id, scale, jpeg: encodeJpeg(sent, 88), message: buildVisionMessage(ctx) };
}

/** Answer coordinates in sent-image pixels -> original image pixels. */
export function scaleAnswer(answer: VisionAnswer, scale: number): VisionAnswer {
  if (scale === 1) return answer;
  const k = 1 / scale;
  return {
    ...answer,
    maps: answer.maps.map((m) => ({
      ...m,
      region: { x: m.region.x * k, y: m.region.y * k, width: m.region.width * k, height: m.region.height * k },
      walls: m.walls.map((w) => ({ ...w, x1: w.x1 * k, y1: w.y1 * k, x2: w.x2 * k, y2: w.y2 * k })),
      lights: m.lights.map((l) => ({ ...l, x: l.x * k, y: l.y * k })),
      pins: m.pins.map((p) => ({ ...p, x: p.x * k, y: p.y * k })),
    })),
  };
}

/** Production path: one vision call per candidate. Not called in testing. */
export async function runMapVision(
  client: AiClient,
  candidates: Candidate[],
  pages: string[],
  locations: MapContext['locations'],
): Promise<{ maps: MapCandidate[]; inputTokens: number; outputTokens: number; cost: number }> {
  const maps: MapCandidate[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  for (const cand of candidates) {
    const req = visionRequestFor(cand, pages, locations);
    const result = await client.generateStructured<unknown>({
      system: VISION_SYSTEM,
      userMessage: req.message,
      tool: { name: VISION_TOOL_NAME, description: 'Submit the battle maps found in the image.', input_schema: VISION_TOOL_SCHEMA as unknown as Record<string, unknown> },
      images: [{ mediaType: 'image/jpeg', data: req.jpeg }],
    });
    maps.push({ ...cand, vision: scaleAnswer(parseVisionAnswer(result.data), req.scale) });
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cost += result.usage.estimatedCost;
  }
  return { maps, inputTokens, outputTokens, cost };
}

/**
 * Square battle-map grid detection. Pure function of the pixels, so it can be
 * called on a crop of a larger image.
 *
 * Method: per-column and per-row projections of a clipped "ridge" response
 * (thin dark OR light lines: both neighbours at distance w lighter, or both darker, than the centre; step edges score zero), high-pass
 * filtered. For each candidate period P the projection is folded modulo P
 * (a comb filter); a real grid concentrates energy in a single phase bin. The
 * period is chosen jointly over both axes (so both must agree), refined to a
 * fractional value, and sub-multiples are preferred over multiples.
 */

export interface GridFit {
  cellPx: number;
  offsetX: number;
  offsetY: number;
  /** 0..1 confidence. */
  score: number;
  cols: number;
  rows: number;
}

export interface GridImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** Contrast (peak over median, in projection std units) mapped to 0..1. */
const SCORE_K = 12;
/** Minimum 0..1 score on BOTH axes to accept a grid. */
const MIN_AXIS_SCORE = 0.5;
/** Minimum mean ridge response (luminance levels per pixel along a line) on both axes. */
const MIN_LINE_AMP = 2.5;
const RIDGE_CLIP = 40;

interface Projections {
  cols: Float64Array;
  rows: Float64Array;
}

function luminance(img: GridImage): Float32Array {
  const { width, height, rgba } = img;
  const L = new Float32Array(width * height);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    const a = rgba[j + 3] / 255;
    // composite over white so transparent regions do not look like edges
    const r = rgba[j] * a + 255 * (1 - a);
    const g = rgba[j + 1] * a + 255 * (1 - a);
    const b = rgba[j + 2] * a + 255 * (1 - a);
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return L;
}

/** Line response from the two neighbour-minus-centre differences: both must have the same sign (dark or light line). */
function ridge(a: number, b: number): number {
  if (a > 0 && b > 0) return a < b ? a : b;
  if (a < 0 && b < 0) return a > b ? -a : -b;
  return 0;
}

function project(img: GridImage): Projections {
  const { width: W, height: H } = img;
  const L = luminance(img);
  const cols = new Float64Array(W);
  const rows = new Float64Array(H);
  const clip = (v: number) => (v > RIDGE_CLIP ? RIDGE_CLIP : v);
  for (let y = 2; y < H - 2; y++) {
    const o = y * W;
    for (let x = 2; x < W - 2; x++) {
      const c = L[o + x];
      // vertical lines: ridge across x (zero on step edges, e.g. JPEG block borders)
      const rx = Math.max(
        ridge(L[o + x - 1] - c, L[o + x + 1] - c),
        ridge(L[o + x - 2] - c, L[o + x + 2] - c),
      );
      // horizontal lines: ridge across y
      const ry = Math.max(
        ridge(L[o - W + x] - c, L[o + W + x] - c),
        ridge(L[o - 2 * W + x] - c, L[o + 2 * W + x] - c),
      );
      cols[x] += clip(rx);
      rows[y] += clip(ry);
    }
  }
  return { cols, rows };
}

/** Subtract a moving average (window 2*half+1) and normalise by std. Returns null if flat. */
function highPass(v: Float64Array, half = 20): (Float64Array & { std?: number }) | null {
  const n = v.length;
  const out = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + v[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = v[i] - (prefix[b] - prefix[a]) / (b - a);
  }
  let s2 = 0;
  for (let i = 4; i < n - 4; i++) s2 += out[i] * out[i];
  const std = Math.sqrt(s2 / Math.max(1, n - 8));
  if (std < 1e-6) return null;
  for (let i = 0; i < n; i++) out[i] /= std;
  (out as Float64Array & { std?: number }).std = std;
  return out as Float64Array & { std?: number };
}

interface Fold {
  contrast: number;
  peak: number; // raw peak-over-median in normalised projection units
  phase: number; // in [0, P)
  energy: number; // sum of squared bin means (sharpness of the comb)
}

/** Fold v modulo P into bins; contrast = (smoothed peak bin - median bin). */
function fold(v: Float64Array, P: number): Fold {
  const nb = Math.max(8, Math.round(P * 2));
  const sum = new Float64Array(nb);
  const cnt = new Float64Array(nb);
  const skip = 4; // ignore image borders (ridge filter is undefined there)
  for (let x = skip; x < v.length - skip; x++) {
    let b = Math.floor(((x % P) / P) * nb);
    if (b >= nb) b = nb - 1;
    sum[b] += v[x];
    cnt[b] += 1;
  }
  const mean = new Float64Array(nb);
  for (let b = 0; b < nb; b++) mean[b] = cnt[b] ? sum[b] / cnt[b] : 0;
  // smooth over 3 bins (+-0.5 px at 2 bins/px) circularly
  const sm = new Float64Array(nb);
  for (let b = 0; b < nb; b++) sm[b] = (mean[(b + nb - 1) % nb] + mean[b] * 2 + mean[(b + 1) % nb]) / 4;
  let best = -Infinity;
  let bi = 0;
  for (let b = 0; b < nb; b++) {
    if (sm[b] > best) {
      best = sm[b];
      bi = b;
    }
  }
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const median = sorted[nb >> 1];
  // phase = midpoint of the contiguous half-maximum extent around the peak
  const half = median + (best - median) / 2;
  let lo = 0;
  let hi = 0;
  while (lo < nb / 2 && sm[(bi - lo - 1 + nb) % nb] > half) lo++;
  while (hi < nb / 2 && sm[(bi + hi + 1) % nb] > half) hi++;
  const phase = ((bi + (hi - lo) / 2) / nb) * P;
  const z = (best - median) * Math.sqrt(((v.length - 2 * skip) / nb) * 2.67);
  let energy = 0;
  for (let b = 0; b < nb; b++) energy += mean[b] * mean[b];
  return { contrast: z, peak: best - median, energy, phase: ((phase % P) + P) % P };
}

const toScore = (contrast: number) => contrast / (contrast + SCORE_K);

export function detectGrid(
  img: GridImage,
  opts: { minCell?: number; maxCell?: number } = {},
): GridFit | null {
  const { width: W, height: H } = img;
  const minCell = opts.minCell ?? 20;
  const maxCell = Math.min(opts.maxCell ?? 200, Math.floor(Math.min(W, H) / 3));
  if (maxCell <= minCell || W < 60 || H < 60) return null;

  const { cols, rows } = project(img);
  const hx = highPass(cols);
  const hy = highPass(rows);
  if (!hx || !hy) return null;

  // Coarse scan with a joint (geometric-mean) contrast on both axes.
  const step = 0.1;
  const nSteps = Math.floor((maxCell - minCell) / step) + 1;
  const jx = new Float64Array(nSteps);
  const jy = new Float64Array(nSteps);
  const joint = new Float64Array(nSteps);
  for (let i = 0; i < nSteps; i++) {
    const P = minCell + i * step;
    jx[i] = Math.max(0, fold(hx, P).contrast);
    jy[i] = Math.max(0, fold(hy, P).contrast);
    joint[i] = Math.sqrt(jx[i] * jy[i]);
  }
  let bi = 0;
  for (let i = 1; i < nSteps; i++) if (joint[i] > joint[bi]) bi = i;
  let P = minCell + bi * step;

  // Prefer a sub-multiple (P/2, P/3) if it scores nearly as well: a grid with
  // period P also folds cleanly at 2P, 3P.
  for (const k of [3, 2]) {
    const target = P / k;
    if (target < minCell) continue;
    const lo = Math.max(0, Math.floor(((target * 0.97 - minCell) / step)));
    const hi = Math.min(nSteps - 1, Math.ceil(((target * 1.03 - minCell) / step)));
    let sb = lo;
    for (let i = lo; i <= hi; i++) if (joint[i] > joint[sb]) sb = i;
    if (joint[sb] >= 0.85 * joint[bi]) {
      bi = sb;
      P = minCell + sb * step;
      break;
    }
  }

  // Refine the period on a fine grid around the best.
  let bestP = P;
  let bestJ = -1;
  for (let p = P - 0.5; p <= P + 0.5 + 1e-9; p += 0.02) {
    if (p < minCell || p > maxCell) continue;
    const j = fold(hx, p).energy * fold(hy, p).energy;
    if (j > bestJ) {
      bestJ = j;
      bestP = p;
    }
  }
  P = bestP;

  const fx = fold(hx, P);
  const fy = fold(hy, P);
  const sx = toScore(fx.contrast);
  const sy = toScore(fy.contrast);
  // absolute line strength: mean ridge response (luminance levels) per pixel along the line
  const ampX = (fx.peak * (hx.std ?? 0)) / H;
  const ampY = (fy.peak * (hy.std ?? 0)) / W;
  const score = Math.min(sx, sy);
  if (score < MIN_AXIS_SCORE) return null;
  // Faint periodic texture (dithering, tiling) can fold cleanly but has no real lines.
  if (Math.min(ampX, ampY) < MIN_LINE_AMP) return null;

  // Independent per-axis periods must agree within 3%.
  const px = bestPeriodNear(hx, P);
  const py = bestPeriodNear(hy, P);
  if (Math.abs(px - py) / P > 0.03) return null;

  return {
    cellPx: P,
    offsetX: fx.phase,
    offsetY: fy.phase,
    score,
    cols: Math.floor(W / P),
    rows: Math.floor(H / P),
  };
}

function bestPeriodNear(v: Float64Array, P: number): number {
  let best = P;
  let bc = -Infinity;
  for (let p = P * 0.97; p <= P * 1.03 + 1e-9; p += 0.05) {
    const c = fold(v, p).contrast;
    if (c > bc) {
      bc = c;
      best = p;
    }
  }
  return best;
}

import { detectGrid } from '../src/maps/grid.js';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  if (!ok) failed++;
}

// deterministic PRNG
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function makeImage(
  W: number,
  H: number,
  fill: (x: number, y: number) => number,
) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = fill(x, y);
      const i = (y * W + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { width: W, height: H, rgba };
}

function crop(img: { width: number; height: number; rgba: Uint8ClampedArray }, x: number, y: number, w: number, h: number) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.width + x) * 4;
    rgba.set(img.rgba.subarray(s, s + w * 4), r * w * 4);
  }
  return { width: w, height: h, rgba };
}

// 1. clean grid: 1px dark lines every 50px, offset 7
const grid = makeImage(800, 600, (x, y) => ((x - 7) % 50 === 0 || (y - 7) % 50 === 0 ? 40 : 210));
const g1 = detectGrid(grid);
check('clean grid detected', g1 !== null, JSON.stringify(g1));
if (g1) {
  check('cellPx ~50', Math.abs(g1.cellPx - 50) < 0.5, `cellPx=${g1.cellPx.toFixed(2)}`);
  check('offsetX ~7', Math.abs(g1.offsetX - 7) < 1.5, `offsetX=${g1.offsetX.toFixed(2)}`);
  check('offsetY ~7', Math.abs(g1.offsetY - 7) < 1.5, `offsetY=${g1.offsetY.toFixed(2)}`);
  check('cols/rows', g1.cols === 16 && g1.rows === 12, `${g1.cols}x${g1.rows}`);
  check('score high', g1.score > 0.6, `score=${g1.score.toFixed(3)}`);
}

// 2. noisy textured background with faint grid (fractional period 48.5)
const noisy = makeImage(900, 700, (x, y) => {
  const base = 128 + 30 * Math.sin(x / 37) * Math.cos(y / 53) + (rnd() - 0.5) * 30;
  const gx = Math.abs(((x - 11) % 48.5) + 48.5) % 48.5 < 1;
  const gy = Math.abs(((y - 20) % 48.5) + 48.5) % 48.5 < 1;
  return gx || gy ? base - 70 : base;
});
const g2 = detectGrid(noisy);
check('noisy fractional grid detected', g2 !== null, JSON.stringify(g2));
if (g2) check('noisy cellPx ~48.5', Math.abs(g2.cellPx - 48.5) < 0.8, `cellPx=${g2.cellPx.toFixed(2)}`);

// 3. no grid: smooth gradient
const grad = makeImage(800, 600, (x, y) => (x / 800) * 120 + (y / 600) * 100);
check('gradient -> null', detectGrid(grad) === null);

// 4. no grid: pure noise and noisy blobs
const noise = makeImage(800, 600, () => rnd() * 255);
check('noise -> null', detectGrid(noise) === null);
const blobs = makeImage(800, 600, (x, y) => 128 + 90 * Math.sin(x / 23) * Math.sin(y / 31) + (rnd() - 0.5) * 20);
check('blobs -> null', detectGrid(blobs) === null);

// 5. grid cropped to a sub-region
const sub = crop(grid, 130, 90, 500, 400);
const g5 = detectGrid(sub);
check('sub-region detected', g5 !== null, JSON.stringify(g5));
if (g5) {
  check('sub-region cellPx ~50', Math.abs(g5.cellPx - 50) < 0.5, `cellPx=${g5.cellPx.toFixed(2)}`);
  // line positions in the crop: (7 - 130) mod 50 = 27 ; (7 - 90) mod 50 = 17
  check('sub-region offsetX ~27', Math.abs(g5.offsetX - 27) < 1.5, `offsetX=${g5.offsetX.toFixed(2)}`);
  check('sub-region offsetY ~17', Math.abs(g5.offsetY - 17) < 1.5, `offsetY=${g5.offsetY.toFixed(2)}`);
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all grid checks passed');

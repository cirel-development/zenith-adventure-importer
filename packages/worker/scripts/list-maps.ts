import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { extractPdfImages, encodeJpeg } from '../src/pdf/images.js';
import { detectGrid } from '../src/maps/grid.js';

/**
 * Usage: pnpm --filter @ai-adventure/worker list:maps -- <pdf> [--out <dir>]
 *
 * Prints one line per image (id, page, size, grid fit or "no grid"). With --out,
 * writes each gridded image as <dir>/<id>.jpg. IMPORTANT: --out must be OUTSIDE
 * the repo (e.g. the system temp dir): book art is copyrighted and the repo is
 * public. The script refuses an --out directory inside the repo.
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  let pdfPath: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outDir = args[++i];
    else if (!pdfPath) pdfPath = args[i];
  }
  if (!pdfPath) {
    console.error('usage: list:maps -- <pdf> [--out <dir>]   (--out must be outside the repo)');
    process.exit(2);
  }
  if (outDir) {
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
    const rel = relative(repoRoot, resolve(outDir));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      console.error(`refusing --out inside the repo (${resolve(outDir)}); use a temp dir`);
      process.exit(2);
    }
    await mkdir(outDir, { recursive: true });
  }

  const bytes = new Uint8Array(await readFile(pdfPath));
  const images = await extractPdfImages(bytes);
  let gridded = 0;
  for (const img of images) {
    const fit = detectGrid(img);
    const size = `${img.width}x${img.height}`;
    if (fit) {
      gridded++;
      console.log(
        `${img.id}\tpage ${img.page}\t${size}\tcell=${fit.cellPx.toFixed(2)}px offset=(${fit.offsetX.toFixed(1)},${fit.offsetY.toFixed(1)}) ${fit.cols}x${fit.rows} score=${fit.score.toFixed(3)}`,
      );
      if (outDir) await writeFile(join(outDir, `${img.id}.jpg`), encodeJpeg(img));
    } else {
      console.log(`${img.id}\tpage ${img.page}\t${size}\tno grid`);
    }
  }
  console.log(`${images.length} images, ${gridded} with grids`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

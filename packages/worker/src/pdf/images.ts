import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import jpeg from 'jpeg-js';

/** A raster image embedded in a PDF, decoded to RGBA (always 4 channels). */
export interface PdfImage {
  /** Stable id: `p<page>-<pdf object id>` (page = first page using it). */
  id: string;
  /** 1-based page number of the first page that paints the image. */
  page: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

function resolveWorkerSrc(): string {
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
}

/** Resolve an object from a pdfjs PDFObjects store, handling the async callback form. */
function getObj(store: any, id: string, timeoutMs = 15000): Promise<any | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeoutMs);
    const finish = (v: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v ?? null);
    };
    try {
      if (typeof store.has === 'function' && store.has(id)) {
        finish(store.get(id));
      } else {
        store.get(id, finish);
      }
    } catch {
      finish(null);
    }
  });
}

/** Convert a pdfjs image object (grayscale 1bpp / RGB 24 / RGBA 32) to RGBA. */
function toRgba(obj: any): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  const width: number = obj?.width;
  const height: number = obj?.height;
  const data: Uint8Array | Uint8ClampedArray | undefined = obj?.data;
  if (!width || !height || !data) return null;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  // pdfjs ImageKind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  let kind: number = obj.kind;
  if (!kind) {
    if (data.length >= n * 4) kind = 3;
    else if (data.length >= n * 3) kind = 2;
    else kind = 1;
  }
  if (kind === 3) {
    if (data.length < n * 4) return null;
    out.set(data.subarray(0, n * 4));
  } else if (kind === 2) {
    if (data.length < n * 3) return null;
    for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
      out[k] = data[j];
      out[k + 1] = data[j + 1];
      out[k + 2] = data[j + 2];
      out[k + 3] = 255;
    }
  } else if (kind === 1) {
    const rowBytes = (width + 7) >> 3;
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const k = (y * width + x) * 4;
        out[k] = v;
        out[k + 1] = v;
        out[k + 2] = v;
        out[k + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return { width, height, rgba: out };
}

/** Cheap content fingerprint (dims + ~8k sampled pixels) to dedupe copies stored under different object ids. */
function fingerprint(img: { width: number; height: number; rgba: Uint8ClampedArray }): string {
  let h = 2166136261;
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 8192));
  for (let p = 0; p < n; p += step) {
    const o = p * 4;
    h = Math.imul(h ^ img.rgba[o], 16777619);
    h = Math.imul(h ^ img.rgba[o + 1], 16777619);
    h = Math.imul(h ^ img.rgba[o + 2], 16777619);
  }
  return `${img.width}x${img.height}:${(h >>> 0).toString(16)}`;
}

/**
 * Extract raster images (raw embedded resolution, not page-rendered) from a PDF.
 * The same image object painted on several pages is returned once, attributed to
 * the first page. Image masks are skipped. Images whose shorter side is below
 * `minSide` (default 300) are skipped.
 */
export async function extractPdfImages(
  pdf: Uint8Array,
  opts: { minSide?: number } = {},
): Promise<PdfImage[]> {
  const minSide = opts.minSide ?? 300;
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = resolveWorkerSrc();
  const OPS = pdfjs.OPS;

  // pdfjs transfers/detaches the buffer; hand it a copy so callers keep theirs.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const seen = new Set<string>();
  const seenContent = new Set<string>();
  const results: PdfImage[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn !== OPS.paintImageXObject) continue; // inline images are small; masks skipped
        const objId: string = ops.argsArray[i][0];
        if (seen.has(objId)) continue;
        seen.add(objId);
        const store = objId.startsWith('g_') ? page.commonObjs : page.objs;
        const obj = await getObj(store, objId);
        if (!obj) continue;
        const conv = toRgba(obj);
        if (!conv) continue;
        if (Math.min(conv.width, conv.height) < minSide) continue;
        const fp = fingerprint(conv);
        if (seenContent.has(fp)) continue;
        seenContent.add(fp);
        results.push({ id: `p${p}-${objId}`, page: p, ...conv });
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return results;
}

/** Crop a rectangle (clamped to the image bounds). Returns a new image with the same id/page. */
export function cropImage(img: PdfImage, x: number, y: number, w: number, h: number): PdfImage {
  const x0 = Math.max(0, Math.min(img.width, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height, Math.round(y)));
  const x1 = Math.max(x0, Math.min(img.width, Math.round(x + w)));
  const y1 = Math.max(y0, Math.min(img.height, Math.round(y + h)));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const rgba = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const src = ((y0 + row) * img.width + x0) * 4;
    rgba.set(img.rgba.subarray(src, src + cw * 4), row * cw * 4);
  }
  return { id: img.id, page: img.page, width: cw, height: ch, rgba };
}

/** Encode RGBA pixels as a JPEG (pure JS, no native modules). */
export function encodeJpeg(
  img: { width: number; height: number; rgba: Uint8ClampedArray },
  quality = 85,
): Uint8Array {
  const encoded = jpeg.encode(
    { data: img.rgba, width: img.width, height: img.height },
    quality,
  );
  return new Uint8Array(encoded.data);
}

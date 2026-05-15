import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Extracted PDF content. Pages are 1-indexed in the source PDF but stored as
 * a 0-indexed array here. Use `pages[n-1]` to get page n.
 */
export interface ExtractedPdf {
  pages: string[];
  pageCount: number;
  totalCharacters: number;
}

/**
 * Resolve pdfjs's worker file path. pdfjs ships pdf.worker.mjs alongside
 * pdf.mjs in its build directory; we use createRequire to find it reliably
 * regardless of how the module is loaded (tsx, packaged, etc).
 */
function resolveWorkerSrc(): string {
  // createRequire gives us a CommonJS-style resolver. We point it at the main
  // pdf.mjs and then ask for the sibling worker file.
  const require = createRequire(import.meta.url);
  const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return pathToFileURL(workerPath).href;
}

/**
 * Read a PDF file and extract per-page text.
 *
 * Notes:
 * - Images are NOT extracted in Phase 1. PDFs store images in formats (JPEG,
 *   JBIG2, etc) that need conversion before our pipeline can use them.
 *   Deferred to Phase 2.
 * - Text extraction quality varies hugely with the source PDF. Born-digital
 *   PDFs (typeset from a text editor) extract cleanly. Scanned PDFs need OCR.
 *   Most Paizo adventures are born-digital.
 */
export async function extractPdf(filePath: string): Promise<ExtractedPdf> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // pdfjs requires workerSrc to be set even in Node. Pointing it at the
  // bundled pdf.worker.mjs file URL works for both Node and tsx.
  (pdfjs as any).GlobalWorkerOptions.workerSrc = resolveWorkerSrc();

  const buffer = await readFile(filePath);
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjs.getDocument({
    data,
    verbosity: 0,
    isEvalSupported: false,
    useSystemFonts: false,
  });

  const doc = await loadingTask.promise;
  const pageCount = doc.numPages;
  const pages: string[] = [];
  let totalCharacters = 0;

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Each item is a text run with positioning info. For Phase 1 we just
    // concatenate them. Phase 2 will use the positioning to detect columns,
    // boxed text, headers, etc.
    const text = content.items
      .map((item: any) => {
        if (typeof item.str === 'string') return item.str;
        return '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    pages.push(text);
    totalCharacters += text.length;
  }

  return {
    pages,
    pageCount,
    totalCharacters,
  };
}

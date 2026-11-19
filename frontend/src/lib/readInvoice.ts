import type { TextPiece } from './invoiceText';

/**
 * The text of a PDF's first pages, with positions, for reading an invoice's details.
 * Returns an empty list for images and for PDFs without text (scans).
 */
export async function pdfText(file: File, maxPages = 3): Promise<TextPiece[]> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return [];
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  try {
    const pieces: TextPiece[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const it of content.items) {
        if ('str' in it && it.str.trim()) pieces.push({ str: it.str, x: it.transform[4], y: it.transform[5], page: n });
      }
      page.cleanup();
    }
    return pieces;
  } finally {
    void doc.destroy();
  }
}

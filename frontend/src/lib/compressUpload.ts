// Shrinks invoice files in the browser so every stored file is at most TARGET_BYTES,
// whatever size was picked. Photos: lower resolution / quality until it fits.
// PDFs: a lossless re-save first; if still too big, each page becomes a compressed image.

/** Every stored invoice file is at most this size. The server enforces the same limit. */
export const TARGET_BYTES = 1024 * 1024;

export interface Compressed {
  file: File;
  originalBytes: number;
  /** How the file was made to fit, for the message shown after choosing it. */
  method: 'unchanged' | 'image' | 'pdf-resaved' | 'pdf-pages-as-images';
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const baseName = (name: string) => name.replace(/\.[^.]+$/, '') || 'invoice';

/** Longest side and quality, tried in order until the result fits. The first step keeps small print legible. */
const IMAGE_STEPS: [number, number][] = [[1800, 0.8], [1600, 0.72], [1400, 0.65], [1200, 0.6], [1000, 0.55], [850, 0.5], [700, 0.45], [550, 0.4]];

function encode(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Smallest of WebP and JPEG (browsers that can't write WebP give back a PNG, which is ignored). */
async function smallestEncoding(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const out = (await Promise.all([encode(canvas, 'image/webp', quality), encode(canvas, 'image/jpeg', quality)]))
    .filter((b): b is Blob => !!b && (b.type === 'image/webp' || b.type === 'image/jpeg'));
  if (!out.length) throw new Error('This image could not be compressed');
  return out.reduce((a, b) => (b.size < a.size ? b : a));
}

function drawScaled(source: CanvasImageSource, width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This file could not be compressed');
  ctx.fillStyle = '#fff'; // transparent PNGs get a white page, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function compressImage(file: File): Promise<Compressed> {
  const image = await createImageBitmap(file).catch(() => { throw new Error('This image could not be read'); });
  try {
    let best: Blob | null = null;
    for (const [side, quality] of IMAGE_STEPS) {
      const blob = await smallestEncoding(drawScaled(image, image.width, image.height, side), quality);
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= TARGET_BYTES) break;
    }
    // A small original that is already smaller than any re-encode is kept as it is.
    if (file.size <= TARGET_BYTES && file.size <= best!.size) return { file, originalBytes: file.size, method: 'unchanged' };
    if (best!.size > TARGET_BYTES) throw new Error('This image could not be made smaller than 1 MB');
    const ext = best!.type === 'image/webp' ? 'webp' : 'jpg';
    return { file: new File([best!], `${baseName(file.name)}.${ext}`, { type: best!.type }), originalBytes: file.size, method: 'image' };
  } finally {
    image.close();
  }
}

/** Page sizes (long side in px) and quality for turning PDF pages into images, best first. */
const PAGE_STEPS: [number, number][] = [[1650, 0.72], [1400, 0.65], [1200, 0.58], [1000, 0.52], [850, 0.46], [700, 0.4], [560, 0.35]];

async function compressPdf(file: File): Promise<Compressed> {
  const original = new Uint8Array(await file.arrayBuffer());
  if (file.size <= TARGET_BYTES) return { file, originalBytes: file.size, method: 'unchanged' };

  const { PDFDocument } = await import('pdf-lib');

  // 1. Lossless: drop unused objects and pack the rest into object streams. Text stays selectable.
  try {
    const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });
    const resaved = await doc.save({ useObjectStreams: true });
    if (resaved.byteLength <= TARGET_BYTES) {
      return { file: new File([new Uint8Array(resaved)], `${baseName(file.name)}.pdf`, { type: 'application/pdf' }), originalBytes: file.size, method: 'pdf-resaved' };
    }
  } catch { /* damaged or unusual PDF: the page-image route below still works */ }

  // 2. Each page drawn as an image and put back into a new PDF, smaller each round until it fits.
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const src = await pdfjs.getDocument({ data: original, isEvalSupported: false }).promise;
  try {
    // More pages need a smaller share of the 1 MB each, so start further down the list.
    const perPage = TARGET_BYTES / src.numPages;
    const start = perPage > 300_000 ? 0 : perPage > 150_000 ? 1 : perPage > 80_000 ? 3 : perPage > 40_000 ? 4 : 5;
    for (const [side, quality] of PAGE_STEPS.slice(start)) {
      const out = await PDFDocument.create();
      for (let n = 1; n <= src.numPages; n++) {
        const page = await src.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: side / Math.max(base.width, base.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('This PDF could not be compressed');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        page.cleanup();
        const jpeg = await encode(canvas, 'image/jpeg', quality);
        if (!jpeg) throw new Error('This PDF could not be compressed');
        const img = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
        // Keep the original page size in points so it prints the same.
        out.addPage([base.width, base.height]).drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
        canvas.width = canvas.height = 0; // free the memory now, not at garbage collection
      }
      const bytes = await out.save({ useObjectStreams: true });
      if (bytes.byteLength <= TARGET_BYTES) {
        return { file: new File([new Uint8Array(bytes)], `${baseName(file.name)}.pdf`, { type: 'application/pdf' }), originalBytes: file.size, method: 'pdf-pages-as-images' };
      }
    }
    throw new Error(`This PDF has too many pages (${src.numPages}) to fit in 1 MB. Split it into smaller files.`);
  } finally {
    await src.destroy();
  }
}

/** Makes an invoice file fit in TARGET_BYTES. PDF, PNG, JPG and WebP only. */
export async function compressInvoiceUpload(file: File): Promise<Compressed> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return compressPdf(file);
  if (IMAGE_TYPES.includes(file.type)) return compressImage(file);
  throw new Error('Choose a PDF, PNG, JPG or WebP invoice');
}

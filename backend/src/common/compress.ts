import { gunzipSync, gzipSync } from 'node:zlib';

export type StoredEncoding = 'gzip' | null;

/**
 * Gzips a file for storage when that saves at least `minSaving` (10% by default).
 * Already-compressed formats (JPEG, WebP, most PDFs) are left alone, so they cost nothing
 * to read back; uncompressed PDFs and PNG screenshots often shrink a lot.
 */
export function compressForStorage(data: Buffer, minSaving = 0.1): { data: Buffer; encoding: StoredEncoding } {
  if (data.length < 1024) return { data, encoding: null };
  const gz = gzipSync(data, { level: 9 });
  return gz.length <= data.length * (1 - minSaving) ? { data: gz, encoding: 'gzip' } : { data, encoding: null };
}

export function decompressFromStorage(data: Buffer, encoding: StoredEncoding): Buffer {
  return encoding === 'gzip' ? gunzipSync(data) : data;
}

/** Real file type from its first bytes. Browsers report the type from the file name, which can lie. */
export function sniffType(data: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

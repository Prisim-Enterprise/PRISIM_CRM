import { randomBytes } from 'node:crypto';
import { compressForStorage, decompressFromStorage, sniffType } from './compress';

describe('compressForStorage', () => {
  it('gzips content that compresses well and restores it exactly', () => {
    const pdf = Buffer.from('%PDF-1.4\n' + 'BT /F1 12 Tf 72 712 Td (Tax Invoice line) Tj ET\n'.repeat(500));
    const out = compressForStorage(pdf);
    expect(out.encoding).toBe('gzip');
    expect(out.data.length).toBeLessThan(pdf.length * 0.2);
    expect(decompressFromStorage(out.data, out.encoding).equals(pdf)).toBe(true);
  });

  it('keeps already-compressed data as it is', () => {
    const jpegLike = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(50_000)]);
    const out = compressForStorage(jpegLike);
    expect(out.encoding).toBeNull();
    expect(out.data).toBe(jpegLike);
  });

  it('skips tiny files', () => {
    expect(compressForStorage(Buffer.alloc(500, 'a')).encoding).toBeNull();
  });

  it('passes plain data through on read', () => {
    const b = Buffer.from('x');
    expect(decompressFromStorage(b, null)).toBe(b);
  });
});

describe('sniffType', () => {
  it('recognises PDF, PNG, JPEG and WebP by their bytes', () => {
    expect(sniffType(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects anything else, whatever its name says', () => {
    expect(sniffType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffType(Buffer.from('MZ\x90\0'))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
});

import { BadRequestException } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { InvoicesService } from './invoices.service';
import { MAX_INVOICE_FILE_BYTES } from './shared';

const u = { id: 'u1', permissions: new Set(['accounting.manage']) } as never;
const multer = (buffer: Buffer, name = 'inv.pdf', mimetype = 'application/pdf') => ({ buffer, size: buffer.length, originalname: name, mimetype }) as Express.Multer.File;

function setup() {
  const saved: { data: Buffer; mime: string }[] = [];
  const prisma = {
    client: { findUnique: jest.fn().mockResolvedValue({ id: 'c1' }) },
    acctInvoiceFile: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f1', ...data })) },
  };
  const storage = {
    save: jest.fn(async (_k: string, data: Buffer, _n: string, mime: string) => { saved.push({ data, mime }); return 'invoices/key'; }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn() };
  const svc = new InvoicesService(prisma as never, audit as never, storage as never, {} as never);
  return { svc, prisma, storage, saved };
}

describe('client invoice file upload', () => {
  it('the limit is 1 MB', () => expect(MAX_INVOICE_FILE_BYTES).toBe(1024 * 1024));

  it('refuses anything over 1 MB without storing it', async () => {
    const { svc, storage } = setup();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_INVOICE_FILE_BYTES)]);
    await expect(svc.uploadClientInvoiceFile(u, 'c1', multer(big))).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('accepts exactly 1 MB', async () => {
    const { svc } = setup();
    const edge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_INVOICE_FILE_BYTES - 9, 'x')]);
    await expect(svc.uploadClientInvoiceFile(u, 'c1', multer(edge))).resolves.toMatchObject({ originalBytes: MAX_INVOICE_FILE_BYTES });
  });

  it('stores a compressible PDF gzipped, with the true type and both sizes', async () => {
    const { svc, prisma, saved } = setup();
    const pdf = Buffer.from('%PDF-1.4\n' + 'BT (Tax Invoice) Tj ET\n'.repeat(4000));
    await svc.uploadClientInvoiceFile(u, 'c1', multer(pdf));
    const row = prisma.acctInvoiceFile.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ mimeType: 'application/pdf', encoding: 'gzip', originalBytes: pdf.length });
    expect(row.sizeBytes).toBeLessThan(pdf.length / 10);
    expect(saved[0].mime).toBe('application/gzip');
    expect(gunzipSync(saved[0].data).equals(pdf)).toBe(true);
  });

  it('uses the type found in the bytes, not the one the browser claims', async () => {
    const { svc, prisma } = setup();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    await svc.uploadClientInvoiceFile(u, 'c1', multer(png, 'scan.pdf', 'application/pdf'));
    expect(prisma.acctInvoiceFile.create.mock.calls[0][0].data.mimeType).toBe('image/png');
  });

  it('rejects files that are not PDF or images, whatever their name', async () => {
    const { svc } = setup();
    await expect(svc.uploadClientInvoiceFile(u, 'c1', multer(Buffer.from('<html><script>x</script>'), 'inv.pdf'))).rejects.toThrow('PDF, PNG, JPG or WebP');
  });

  it('removes the stored file if the database write fails', async () => {
    const { svc, prisma, storage } = setup();
    prisma.acctInvoiceFile.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.uploadClientInvoiceFile(u, 'c1', multer(Buffer.from('%PDF-1.4 small')))).rejects.toThrow('db down');
    expect(storage.remove).toHaveBeenCalledWith('invoices/key');
  });
});

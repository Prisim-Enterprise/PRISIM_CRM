import { BadRequestException } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { Prisma } from '@prisma/client';
import { InvoicesService, shapeInvoiceFile } from './invoices.service';
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

describe('client-wise list of invoice files', () => {
  it('returns every file with its client and the uploader\'s name, never the uploader id', async () => {
    const prisma = {
      acctInvoiceFile: { findMany: jest.fn().mockResolvedValue([
        { id: 'f2', clientId: 'c2', fileName: 'b.pdf', uploadedById: 'u2', client: { id: 'c2', name: 'Beta', status: 'ACTIVE' } },
        { id: 'f1', clientId: 'c1', fileName: 'a.pdf', uploadedById: 'gone', client: { id: 'c1', name: 'Acme', status: 'ACTIVE' } },
      ]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u2', fullName: 'Priya Nair' }]) },
    };
    const svc = new InvoicesService(prisma as never, {} as never, {} as never, {} as never);
    const rows = await svc.listAllInvoiceFiles();
    expect(prisma.acctInvoiceFile.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    expect(rows).toMatchObject([
      { id: 'f2', clientId: 'c2', fileName: 'b.pdf', client: { id: 'c2', name: 'Beta', status: 'ACTIVE' }, uploadedBy: 'Priya Nair', amount: null, status: null },
      { id: 'f1', clientId: 'c1', fileName: 'a.pdf', client: { id: 'c1', name: 'Acme', status: 'ACTIVE' }, uploadedBy: null },
    ]);
    expect(rows.every((r) => !('uploadedById' in r))).toBe(true);
  });
});

describe('uploaded invoice details', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'f1', clientId: 'c1', fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1, originalBytes: 1, encoding: null, createdAt: new Date(),
    invoiceNumber: 'INV-9', invoiceDate: new Date('2026-11-01T00:00:00Z'), dueDate: new Date('2026-11-16T00:00:00Z'),
    amount: new Prisma.Decimal(47200), amountReceived: new Prisma.Decimal(0), paymentMethod: null, ...over,
  });

  it('works out balance and status like a CRM invoice', () => {
    expect(shapeInvoiceFile(row(), '2026-11-10')).toMatchObject({ invoiceDate: '2026-11-01', dueDate: '2026-11-16', amount: 47200, amountReceived: 0, balance: 47200, status: 'unpaid' });
    expect(shapeInvoiceFile(row(), '2026-11-20').status).toBe('overdue');
    expect(shapeInvoiceFile(row({ amountReceived: new Prisma.Decimal(20000) }), '2026-11-10')).toMatchObject({ balance: 27200, status: 'partial' });
    expect(shapeInvoiceFile(row({ amountReceived: new Prisma.Decimal(47200) }), '2026-11-20')).toMatchObject({ balance: 0, status: 'paid' });
  });

  it('a file uploaded without details has no total or status', () => {
    expect(shapeInvoiceFile(row({ invoiceNumber: null, invoiceDate: null, dueDate: null, amount: null }), '2026-11-10')).toMatchObject({ amount: null, balance: null, status: null });
  });

  it('refuses more received than the total, or a due date before the invoice date', async () => {
    const { svc, prisma } = setup();
    (prisma.acctInvoiceFile as Record<string, unknown>).findUnique = jest.fn().mockResolvedValue(row());
    await expect(svc.updateInvoiceFileDetails(u, 'f1', { invoiceNumber: 'X', invoiceDate: '2026-11-01', amount: 100, amountReceived: 101 })).rejects.toThrow(/more than the invoice total/);
    await expect(svc.updateInvoiceFileDetails(u, 'f1', { invoiceNumber: 'X', invoiceDate: '2026-11-10', dueDate: '2026-11-01', amount: 100 })).rejects.toThrow(/before the invoice date/);
    await expect(svc.updateInvoiceFileDetails(u, 'f1', { invoiceNumber: 'X', invoiceDate: '2026-11-01', amount: 100, amountReceived: 40 })).rejects.toThrow(/mode of payment/);
  });
});

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../common/storage.service';
import { AuthUser } from '../common/current-user';
import { compressForStorage, sniffType } from '../common/compress';
import { InvoiceDto, InvoiceQuery, PaymentDto, UpdateInvoiceDto } from './dto';
import { AccountingSettingsService } from './settings.service';
import {
  assertClientExists, assertProjectExists, day, INVOICE_FILE_TYPES, invoiceInclude, invoicePrefix, iso, MAX_INVOICE_FILE_BYTES,
  nextInvoiceSequence, num, shapeInvoice, today,
} from './shared';

const isUniqueClash = (e: unknown) => (e as { code?: string }).code === 'P2002';
const INVOICE_FILE_FIELDS = {
  id: true, clientId: true, fileName: true, mimeType: true, sizeBytes: true, originalBytes: true, encoding: true, createdAt: true,
} as const;

/** Tax invoices, their payments, and the scanned invoice files kept against a client. */
@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService, private audit: AuditService, private storage: StorageService, private cfg: AccountingSettingsService) {}

  async nextInvoiceNumber(date = today()) {
    const prefix = invoicePrefix(await this.cfg.settings(), date);
    const rows = await this.prisma.acctInvoice.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } });
    return { number: nextInvoiceSequence(prefix, rows.map((r) => r.number)) };
  }

  async listInvoices(q: InvoiceQuery) {
    const s = q.search?.trim();
    const rows = await this.prisma.acctInvoice.findMany({
      where: {
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(s ? { OR: [{ number: { contains: s, mode: 'insensitive' } }, { clientName: { contains: s, mode: 'insensitive' } }] } : {}),
      },
      include: invoiceInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 1000,
    });
    const settings = await this.cfg.settings();
    const all = rows.map((r) => shapeInvoice(r, settings));
    return q.status ? all.filter((r) => r.status === q.status) : all;
  }

  async getInvoice(id: string) {
    const i = await this.prisma.acctInvoice.findUnique({ where: { id }, include: invoiceInclude });
    if (!i) throw new NotFoundException('Invoice not found');
    return shapeInvoice(i, await this.cfg.settings());
  }

  private invoiceData(dto: UpdateInvoiceDto) {
    const cd = dto.clientDetails;
    return {
      date: dto.date ? day(dto.date) : undefined, dueDate: dto.dueDate === undefined ? undefined : dto.dueDate ? day(dto.dueDate) : null,
      clientId: dto.clientId, clientName: dto.clientName?.trim(),
      clientDetails: cd ? ({
        contactPerson: cd.contactPerson?.trim() ?? '', phone: cd.phone?.trim() ?? '', email: cd.email?.trim() ?? '',
        gstin: (cd.gstin ?? '').trim().toUpperCase(), address: cd.address?.trim() ?? '', stateCode: cd.stateCode ?? '',
      } as Prisma.InputJsonValue) : undefined,
      items: dto.items ? (dto.items.map((i) => ({
        description: i.description.trim(), hsn: (i.hsn ?? '').trim().toUpperCase(), qty: i.qty, unit: (i.unit ?? '').trim(), rate: i.rate,
      })) as unknown as Prisma.InputJsonValue) : undefined,
      extra: dto.extra ? (Object.fromEntries(Object.entries(dto.extra).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v)) as Prisma.InputJsonValue) : undefined,
      shipTo: dto.shipTo === undefined ? undefined : dto.shipTo === null ? Prisma.DbNull : ({
        name: dto.shipTo.name.trim(), address: dto.shipTo.address?.trim() ?? '', gstin: (dto.shipTo.gstin ?? '').trim().toUpperCase(), stateCode: dto.shipTo.stateCode ?? '',
      } as Prisma.InputJsonValue),
      discount: dto.discount, gstRate: dto.gstRate, notes: dto.notes === undefined ? undefined : dto.notes?.trim() || null,
      terms: dto.terms ? dto.terms.map((t) => t.trim()).filter(Boolean) : undefined,
      preparedBy: dto.preparedBy === undefined ? undefined : dto.preparedBy?.trim() || null, projectId: dto.projectId, cancelled: dto.cancelled,
    };
  }

  async createInvoice(u: AuthUser, dto: InvoiceDto, quotationId?: string) {
    await assertClientExists(this.prisma, dto.clientId);
    await assertProjectExists(this.prisma, dto.projectId);
    const number = dto.number?.trim() || (await this.nextInvoiceNumber(dto.date.slice(0, 10))).number;
    try {
      const data = this.invoiceData(dto);
      const i = await this.prisma.acctInvoice.create({
        data: {
          ...data, number, date: day(dto.date), clientName: dto.clientName.trim(), clientDetails: data.clientDetails!, items: data.items!, terms: data.terms!,
          quotationId: quotationId ?? null, createdById: u.id,
        },
        include: invoiceInclude,
      });
      const shaped = shapeInvoice(i, await this.cfg.settings());
      await this.audit.record({ actorId: u.id, action: 'accounting.invoice_created', entityType: 'acct_invoice', entityId: i.id, after: { number, client: i.clientName, total: shaped.total } });
      return shaped;
    } catch (e) {
      if (isUniqueClash(e)) throw new ConflictException(`Invoice number ${number} is already used`);
      throw e;
    }
  }

  /** A new invoice filled in from a quotation (its items, client and GST). */
  async invoiceFromQuotation(u: AuthUser, quotationId: string) {
    const q = await this.prisma.quotation.findUnique({ where: { id: quotationId }, include: { client: { select: { contactName: true, phone: true, email: true } } } });
    if (!q) throw new NotFoundException('Quotation not found');
    const s = await this.cfg.settings();
    const date = today();
    const [y, m, d] = date.split('-').map(Number);
    const due = new Date(Date.UTC(y, m - 1, d + s.invoiceDueDays)).toISOString().slice(0, 10);
    const items = (q.items as { title: string; points: string[]; qty: string; amount: number }[]).map((it) => ({
      description: [it.title, ...(it.points ?? []).map((p) => `• ${p}`)].join('\n').slice(0, 1000),
      hsn: s.defaultHsn, qty: 1, unit: '', rate: Number(it.amount) || 0,
    }));
    const project = q.clientId ? await this.prisma.acctProject.findFirst({ where: { clientId: q.clientId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, select: { id: true } }) : null;
    return this.createInvoice(u, {
      date, dueDate: due, clientId: q.clientId, clientName: q.clientName,
      clientDetails: { contactPerson: q.client?.contactName ?? '', phone: q.client?.phone ?? '', email: q.client?.email ?? '', gstin: '', address: q.address ?? '' },
      items, discount: 0, gstRate: num(q.gstRate), notes: null, terms: s.invoiceTerms, preparedBy: u.fullName,
      extra: { otherReferences: `Quotation ${q.number}` },
      projectId: project?.id ?? null,
    }, q.id);
  }

  async updateInvoice(u: AuthUser, id: string, dto: UpdateInvoiceDto) {
    const before = await this.prisma.acctInvoice.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Invoice not found');
    await assertClientExists(this.prisma, dto.clientId);
    await assertProjectExists(this.prisma, dto.projectId);
    try {
      const i = await this.prisma.acctInvoice.update({ where: { id }, data: { ...this.invoiceData(dto), number: dto.number?.trim() }, include: invoiceInclude });
      const shaped = shapeInvoice(i, await this.cfg.settings());
      await this.audit.record({
        actorId: u.id, action: dto.cancelled !== undefined && dto.cancelled !== before.cancelled ? (dto.cancelled ? 'accounting.invoice_cancelled' : 'accounting.invoice_restored') : 'accounting.invoice_updated',
        entityType: 'acct_invoice', entityId: id, before: { number: before.number }, after: { number: i.number, total: shaped.total },
      });
      return shaped;
    } catch (e) {
      if (isUniqueClash(e)) throw new ConflictException(`Invoice number ${dto.number} is already used`);
      throw e;
    }
  }

  async removeInvoice(u: AuthUser, id: string) {
    const i = await this.prisma.acctInvoice.findUnique({ where: { id }, include: { _count: { select: { payments: true } } } });
    if (!i) throw new NotFoundException('Invoice not found');
    if (i._count.payments) throw new BadRequestException('This invoice has payments recorded. Cancel it instead, so the record stays.');
    await this.prisma.acctInvoice.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_deleted', entityType: 'acct_invoice', entityId: id, before: { number: i.number, client: i.clientName } });
    return { deleted: true };
  }

  // ── Payments ──
  async addInvoicePayment(u: AuthUser, id: string, dto: PaymentDto) {
    const inv = await this.getInvoice(id);
    if (inv.cancelled) throw new BadRequestException('This invoice is cancelled');
    if (dto.amount > inv.balance + 0.005) throw new BadRequestException(`That is more than the balance due (₹${inv.balance.toFixed(2)})`);
    await this.prisma.acctInvoicePayment.create({
      data: { invoiceId: id, amount: dto.amount, paidOn: day(dto.paidOn), method: dto.method ?? 'BANK_TRANSFER', note: dto.note?.trim() || null },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_payment_added', entityType: 'acct_invoice', entityId: id, after: { number: inv.number, amount: dto.amount, paidOn: dto.paidOn } });
    return this.getInvoice(id);
  }

  async removeInvoicePayment(u: AuthUser, id: string) {
    const pay = await this.prisma.acctInvoicePayment.findUnique({ where: { id } });
    if (!pay) throw new NotFoundException('Payment not found');
    await this.prisma.acctInvoicePayment.delete({ where: { id } });
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_payment_removed', entityType: 'acct_invoice', entityId: pay.invoiceId, before: { amount: num(pay.amount), paidOn: iso(pay.paidOn) } });
    return this.getInvoice(pay.invoiceId);
  }

  // ── Invoice files kept against a client ──
  private async assertClient(clientId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) throw new NotFoundException('Client not found');
  }

  /** Every uploaded invoice file, newest first, with its client and who uploaded it, for the client-wise view. */
  async listAllInvoiceFiles() {
    const files = await this.prisma.acctInvoiceFile.findMany({
      orderBy: { createdAt: 'desc' },
      select: { ...INVOICE_FILE_FIELDS, uploadedById: true, client: { select: { id: true, name: true, status: true } } },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(files.map((f) => f.uploadedById))] } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((x) => [x.id, x.fullName]));
    return files.map(({ uploadedById, ...f }) => ({ ...f, uploadedBy: names.get(uploadedById) ?? null }));
  }

  async listClientInvoiceFiles(clientId: string) {
    await this.assertClient(clientId);
    return this.prisma.acctInvoiceFile.findMany({ where: { clientId }, orderBy: { createdAt: 'desc' }, select: INVOICE_FILE_FIELDS });
  }

  /**
   * Stores a client's invoice file. The type is read from the file's bytes, not the name, and the
   * file is gzipped in storage when that saves 10% or more (the web app already shrinks photos).
   */
  async uploadClientInvoiceFile(u: AuthUser, clientId: string, file?: Express.Multer.File) {
    await this.assertClient(clientId);
    if (!file?.buffer?.length) throw new BadRequestException('No invoice file uploaded');
    if (file.buffer.length > MAX_INVOICE_FILE_BYTES) throw new BadRequestException('Invoice files must be 1 MB or smaller. Upload it from the Invoices page, which compresses it for you.');
    const mimeType = sniffType(file.buffer);
    if (!mimeType || !INVOICE_FILE_TYPES.includes(mimeType)) throw new BadRequestException('Invoices must be a PDF, PNG, JPG or WebP file');
    const stored = compressForStorage(file.buffer);
    const key = await this.storage.save('invoices', stored.data, file.originalname, stored.encoding ? 'application/gzip' : mimeType);
    let saved;
    try {
      saved = await this.prisma.acctInvoiceFile.create({ data: {
        clientId, storageKey: key, fileName: file.originalname.slice(0, 200), mimeType,
        sizeBytes: stored.data.length, originalBytes: file.buffer.length, encoding: stored.encoding, uploadedById: u.id,
      }, select: INVOICE_FILE_FIELDS });
    } catch (err) {
      await this.storage.remove(key).catch(() => undefined);
      throw err;
    }
    await this.audit.record({
      actorId: u.id, action: 'accounting.invoice_file_uploaded', entityType: 'acct_invoice_file', entityId: saved.id,
      after: { clientId, fileName: saved.fileName, originalBytes: saved.originalBytes, sizeBytes: saved.sizeBytes, encoding: saved.encoding },
    });
    return saved;
  }

  async clientInvoiceFile(id: string, res: Response) {
    const file = await this.prisma.acctInvoiceFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('Invoice file not found');
    return this.storage.send(res, file.storageKey, file.mimeType, undefined, file.fileName, file.encoding);
  }

  async removeClientInvoiceFile(u: AuthUser, id: string) {
    const file = await this.prisma.acctInvoiceFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('Invoice file not found');
    await this.prisma.acctInvoiceFile.delete({ where: { id } });
    await this.storage.remove(file.storageKey).catch(() => undefined);
    await this.audit.record({ actorId: u.id, action: 'accounting.invoice_file_deleted', entityType: 'acct_invoice_file', entityId: id, before: { clientId: file.clientId, fileName: file.fileName } });
    return { deleted: true };
  }
}

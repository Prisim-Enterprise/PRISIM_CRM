import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/current-user';
import { SettingsDto } from './dto';
import { AcctSettingsData, DEFAULT_SETTINGS } from './shared';

/** Company details, invoice numbering and the financial year: one row (id 1) of JSON. */
@Injectable()
export class AccountingSettingsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async settings(): Promise<AcctSettingsData> {
    const row = await this.prisma.acctSettings.findUnique({ where: { id: 1 } });
    const data = (row?.data ?? {}) as Partial<AcctSettingsData>;
    return { ...DEFAULT_SETTINGS, ...data, bank: { ...DEFAULT_SETTINGS.bank, ...(data.bank ?? {}) } };
  }

  async saveSettings(u: AuthUser, dto: SettingsDto) {
    const data = { ...dto, gstin: dto.gstin.trim().toUpperCase(), invoiceTerms: dto.invoiceTerms.map((t) => t.trim()).filter(Boolean) };
    await this.prisma.acctSettings.upsert({
      where: { id: 1 }, create: { id: 1, data: data as unknown as Prisma.InputJsonValue }, update: { data: data as unknown as Prisma.InputJsonValue },
    });
    await this.audit.record({ actorId: u.id, action: 'accounting.settings_updated', entityType: 'accounting', after: { companyName: data.companyName, invoicePrefix: data.invoicePrefix } });
    return this.settings();
  }
}

import { DEFAULT_MAPPING, normalizeRow, parseCsv, rowsToObjects, RowRejected } from './lead-ingest';

describe('lead ingest', () => {
  const sheet = [
    ['id', 'created_time', 'campaign_name', 'full_name', 'phone_number', 'email'],
    ['l:111', '2026-11-01T10:00:00+0530', 'Diwali Offer', 'Asha Rao', 'p:+919876543210', 'ASHA@Example.com'],
    ['l:112', '2026-11-01T11:00:00+0530', 'Diwali Offer', 'No Contact', '', ''],
    ['', '2026-11-01T12:00:00+0530', 'Diwali Offer', 'Ravi', '98765 43211', ''],
  ];

  it('maps rows with sheet row numbers', () => {
    const { rows } = rowsToObjects(sheet, 1);
    expect(rows[0].rowNumber).toBe(2);
    expect(rows[0].data.full_name).toBe('Asha Rao');
  });

  it('normalises Meta phone and email formats', () => {
    const { rows } = rowsToObjects(sheet, 1);
    const lead = normalizeRow(rows[0].data, DEFAULT_MAPPING);
    expect(lead.phoneE164).toBe('+919876543210');
    expect(lead.email).toBe('asha@example.com');
    expect(lead.externalLeadId).toBe('l:111');
    expect(lead.sourceCreatedAt?.toISOString()).toBe('2026-11-01T04:30:00.000Z');
  });

  it('rejects rows without a phone or email', () => {
    const { rows } = rowsToObjects(sheet, 1);
    expect(() => normalizeRow(rows[1].data, DEFAULT_MAPPING)).toThrow(RowRejected);
  });

  it('derives a stable id when the source id is missing', () => {
    const { rows } = rowsToObjects(sheet, 1);
    const a = normalizeRow(rows[2].data, DEFAULT_MAPPING);
    const b = normalizeRow({ ...rows[2].data }, DEFAULT_MAPPING);
    expect(a.externalLeadId).toMatch(/^h:/);
    expect(a.externalLeadId).toBe(b.externalLeadId);
    expect(a.phoneE164).toBe('+919876543211');
  });

  it('parses quoted CSV', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

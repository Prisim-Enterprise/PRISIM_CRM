import { DEFAULT_MAPPING, normalizeRow, parseCsv, parseSheetDate, resolveColumns, rowsToObjects } from './lead-ingest';
import { parseSheetRef, toLeadRecords } from './integrations';

describe('website sheet columns', () => {
  it('detects common website-form headers without any mapping', () => {
    const { headers, rows } = rowsToObjects(parseCsv('Timestamp,Your Name,Mobile No.,E-mail,City,Message\n03/11/2026 14:05:00,Asha K,98450 12345,ASHA@X.COM,Chennai,Need 2BHK'), 1);
    expect(resolveColumns(headers, DEFAULT_MAPPING)).toMatchObject({ fullName: 'your_name', phone: 'mobile_no', email: 'e_mail', city: 'city', createdTime: 'timestamp' });
    const n = normalizeRow(rows[0].data, DEFAULT_MAPPING);
    expect(n).toMatchObject({ fullName: 'Asha K', phoneE164: '+919845012345', email: 'asha@x.com', city: 'Chennai' });
    expect(n.sourceCreatedAt?.toISOString()).toBe('2026-11-03T08:35:00.000Z'); // 14:05 IST
    expect(n.externalLeadId).toMatch(/^h:/);
  });

  it('an explicit mapping wins over aliases', () => {
    const n = normalizeRow({ name: 'Alias', client: 'Mapped', phone: '9845012345' }, { ...DEFAULT_MAPPING, fullName: 'client' });
    expect(n.fullName).toBe('Mapped');
  });

  it('keeps blank rows when asked so row numbers match the sheet', () => {
    expect(parseCsv('a,b\n,\nx,y', true)).toHaveLength(3);
    expect(parseCsv('a,b\n,\nx,y')).toHaveLength(2);
  });
});

describe('parseSheetDate', () => {
  it('reads Meta ISO offsets and day-first dates with AM/PM', () => {
    expect(parseSheetDate('2026-11-03T10:15:00+0530')?.toISOString()).toBe('2026-11-03T04:45:00.000Z');
    expect(parseSheetDate('3/11/2026 2:05 PM')?.toISOString()).toBe('2026-11-03T08:35:00.000Z');
    expect(parseSheetDate('31/13/2026')).toBeNull();
  });
});

describe('parseSheetRef', () => {
  it('takes the id and tab from a share link', () => {
    expect(parseSheetRef('https://docs.google.com/spreadsheets/d/1FkHtW51v3pJN3ZEqBsw3JVheaZ7qenShG7W6ON986A0/edit?usp=sharing'))
      .toEqual({ spreadsheetId: '1FkHtW51v3pJN3ZEqBsw3JVheaZ7qenShG7W6ON986A0', gid: undefined });
    expect(parseSheetRef('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=456')).toEqual({ spreadsheetId: 'abc_123', gid: '456' });
    expect(parseSheetRef(' abc ')).toEqual({ spreadsheetId: 'abc', gid: undefined });
  });
});

describe('toLeadRecords (webhook bodies)', () => {
  it('accepts a single object, arrays and wrapped lists', () => {
    expect(toLeadRecords({ Name: 'A', Phone: '1' })).toEqual([{ name: 'A', phone: '1' }]);
    expect(toLeadRecords([{ name: 'A' }, { name: 'B' }])).toHaveLength(2);
    expect(toLeadRecords({ leads: [{ name: 'A' }] })).toEqual([{ name: 'A' }]);
    expect(toLeadRecords({ data: { name: 'A' } })).toEqual([{ name: 'A' }]);
  });
  it('flattens one level and Meta field_data', () => {
    expect(toLeadRecords({ contact: { 'Full Name': 'A', mobile: 9 }, field_data: [{ name: 'city', values: ['Chennai'] }] }))
      .toEqual([{ full_name: 'A', mobile: '9', city: 'Chennai' }]);
  });
  it('ignores junk', () => {
    expect(toLeadRecords('x')).toEqual([]);
    expect(toLeadRecords(null)).toEqual([]);
  });
});

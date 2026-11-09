import { stripVercelPathProperty, stripVercelPathQuery } from './app.setup';

describe('stripVercelPathQuery', () => {
  it('removes Vercel’s catch-all path query while preserving app filters', () => {
    expect(stripVercelPathQuery('/api/v1/leads?path=api%2Fv1%2Fleads&source=website&pageSize=8'))
      .toBe('/api/v1/leads?source=website&pageSize=8');
  });

  it('leaves normal query strings unchanged', () => {
    expect(stripVercelPathQuery('/api/v1/reports/dashboard?from=2026-10-11&to=2026-11-09'))
      .toBe('/api/v1/reports/dashboard?from=2026-10-11&to=2026-11-09');
  });

  it('removes Vercel’s injected path property while retaining query filters', () => {
    expect(stripVercelPathProperty({ path: 'api/v1/leads', source: 'website', pageSize: '8' }))
      .toEqual({ source: 'website', pageSize: '8' });
  });
});

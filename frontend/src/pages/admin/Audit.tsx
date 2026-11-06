import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, Paged } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Card, PageHeader, Pagination, Select, Spinner, Table, Td, Th } from '../../components/ui';

interface Entry { id: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; ip: string | null; createdAt: string; actor: { fullName: string } | null }

export default function AdminAudit() {
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['audit', page, entityType], queryFn: () => api.get<Paged<Entry>>('/audit', { page, pageSize: 50, entityType }) });
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Who changed what and when: logins, assignments, status changes, permissions, exports, recordings played"
        actions={
          <Select value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} className="w-44">
            <option value="">All areas</option>
            {['lead', 'user', 'role', 'team', 'task', 'call', 'follow_up', 'feedback', 'integration', 'sync_run'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </Select>
        } />
      <Card>
        {isLoading || !data ? <Spinner /> : (
          <>
            <Table>
              <thead><tr><Th>When</Th><Th>Who</Th><Th>Action</Th><Th>Record</Th><Th>Details</Th></tr></thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-slate-50">
                    <Td className="whitespace-nowrap text-slate-500">{fmtDateTime(e.createdAt)}</Td>
                    <Td>{e.actor?.fullName ?? <span className="text-slate-400">System / anonymous</span>}</Td>
                    <Td className="font-mono text-xs">{e.action}</Td>
                    <Td className="text-xs text-slate-500">{e.entityType}{e.entityId && <span className="block font-mono">{e.entityId.slice(0, 8)}…</span>}</Td>
                    <Td>
                      {(e.before || e.after) ? (
                        open === e.id ? (
                          <pre className="max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px]" onClick={() => setOpen(null)}>
                            {e.before ? `before: ${JSON.stringify(e.before, null, 1)}\n` : ''}{e.after ? `after: ${JSON.stringify(e.after, null, 1)}` : ''}
                          </pre>
                        ) : <button className="text-xs text-indigo-700 hover:underline" onClick={() => setOpen(e.id)}>Show</button>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}

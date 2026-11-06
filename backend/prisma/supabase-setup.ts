// One-time Supabase setup: the private file bucket and, once the CRM has a public
// address, the once-a-minute trigger for scheduled jobs.
// Usage: npm run supabase:setup   (needs CRON_SECRET and an https PUBLIC_API_URL for the trigger)
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  await db.$executeRawUnsafe(`
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('crm-files', 'crm-files', false, 26214400)
    on conflict (id) do update set public = false, file_size_limit = 26214400`);
  console.log('File bucket crm-files is ready (private, 25 MB limit).');

  const url = process.env.PUBLIC_API_URL?.replace(/\/$/, '');
  const secret = process.env.CRON_SECRET;
  if (!secret || !url?.startsWith('https://')) {
    console.log('Skipped the job trigger: set CRON_SECRET and an https PUBLIC_API_URL first.');
    return;
  }
  await db.$executeRawUnsafe('create extension if not exists pg_cron');
  await db.$executeRawUnsafe('create extension if not exists pg_net');
  const command = `select net.http_post(url := '${url}/api/v1/internal/tick', headers := jsonb_build_object('x-cron-secret', '${secret}'), timeout_milliseconds := 55000)`;
  await db.$queryRawUnsafe(`select cron.schedule('crm-tick', '* * * * *', $cmd$${command}$cmd$)`);
  console.log(`Job trigger set: every minute to ${url}/api/v1/internal/tick`);
}

main().finally(() => db.$disconnect());

-- Supabase exposes the public schema through its Data API, which anyone holding the
-- publishable key can call. Row-level security with no policies blocks that route.
-- The CRM connects as the table owner, so it is not affected.
-- Any table added by a later migration needs the same line.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

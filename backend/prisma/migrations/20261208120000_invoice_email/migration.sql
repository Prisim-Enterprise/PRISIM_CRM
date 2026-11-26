-- Invoices show info@prisim.co.in as Prisim's email. Replaces the old address if it was saved in the settings.
UPDATE "acct_settings"
SET "data" = jsonb_set("data"::jsonb, '{email}', '"info@prisim.co.in"'), "updatedAt" = now()
WHERE "data"::jsonb ->> 'email' = 'varuncena12@gmail.com';

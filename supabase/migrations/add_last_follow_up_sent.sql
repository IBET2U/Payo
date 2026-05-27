-- Run in Supabase SQL Editor (or via CLI migration)
ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS last_follow_up_sent timestamptz;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS follow_up_count integer NOT NULL DEFAULT 0;

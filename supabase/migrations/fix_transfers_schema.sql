-- Sync transfers table with expected Payo Send Money schema.
-- Safe to run multiple times on existing databases.

CREATE TABLE IF NOT EXISTS transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id text NOT NULL,
  amount numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS recipient_type text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS recipient_id text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS recipient_phone_or_email text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS provider_reference text;

CREATE INDEX IF NOT EXISTS transfers_sender_id_created_at_idx
  ON transfers (sender_id, created_at DESC);

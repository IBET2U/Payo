-- Wallet balance for Payo Send Money
ALTER TABLE freelancer_profiles
ADD COLUMN IF NOT EXISTS wallet_balance numeric DEFAULT 0;

-- Transfers ledger
CREATE TABLE IF NOT EXISTS transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id text NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('payo','external')),
  recipient_id text,
  recipient_phone_or_email text,
  amount numeric NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  provider text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transfers_sender_id_created_at_idx
  ON transfers (sender_id, created_at DESC);


-- Tier and earnings on freelancer profiles
ALTER TABLE freelancer_profiles
ADD COLUMN IF NOT EXISTS tier text DEFAULT 'BRONZE',
ADD COLUMN IF NOT EXISTS monthly_volume numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS monthly_earnings numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS monthly_transaction_earnings numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS monthly_network_earnings numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_earnings numeric DEFAULT 0;

CREATE TABLE IF NOT EXISTS monthly_earnings_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  month text NOT NULL,
  tier text,
  monthly_volume numeric,
  transaction_earnings numeric,
  network_earnings numeric,
  total_earnings numeric,
  credited_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monthly_earnings_history_user_id_month_idx
  ON monthly_earnings_history (user_id, month DESC);

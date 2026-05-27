ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS client_phone text;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS freelancer_phone text;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'web';

ALTER TABLE invoices
ALTER COLUMN client_email DROP NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_freelancer_id_client_phone_idx
  ON invoices (freelancer_id, client_phone);

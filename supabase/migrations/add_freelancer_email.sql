ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS freelancer_email text;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS paid_at timestamptz;

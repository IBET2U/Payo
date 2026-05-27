ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS payment_url text;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS payment_reference text;

ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'NGN';

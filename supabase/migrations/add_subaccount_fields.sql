ALTER TABLE freelancer_profiles
ADD COLUMN IF NOT EXISTS subaccount_code text,
ADD COLUMN IF NOT EXISTS bank_code text,
ADD COLUMN IF NOT EXISTS bank_account_number text,
ADD COLUMN IF NOT EXISTS bank_account_name text,
ADD COLUMN IF NOT EXISTS business_name text;

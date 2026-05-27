CREATE TABLE IF NOT EXISTS freelancer_profiles (
  id text primary key,
  email text,
  name text,
  wallet_address text,
  phone text,
  language text default 'english',
  created_at timestamp default now()
);

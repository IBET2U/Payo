-- Payo Checkout: product pages with digital delivery and VAT

ALTER TABLE freelancer_profiles
ADD COLUMN IF NOT EXISTS username text;

CREATE TABLE IF NOT EXISTS checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id text NOT NULL REFERENCES freelancer_profiles(id),
  product_name text NOT NULL,
  description text,
  price numeric NOT NULL,
  currency text NOT NULL DEFAULT 'NGN',
  slug text NOT NULL UNIQUE,
  collect_name boolean NOT NULL DEFAULT true,
  collect_email boolean NOT NULL DEFAULT true,
  collect_phone boolean NOT NULL DEFAULT true,
  thank_you_message text,
  stock_limit integer,
  stock_remaining integer,
  is_digital boolean NOT NULL DEFAULT false,
  download_url text,
  add_vat boolean NOT NULL DEFAULT false,
  vat_rate numeric,
  is_active boolean NOT NULL DEFAULT true,
  total_sales integer NOT NULL DEFAULT 0,
  total_revenue numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkouts_seller_id_idx ON checkouts(seller_id);
CREATE INDEX IF NOT EXISTS checkouts_slug_idx ON checkouts(slug);

CREATE TABLE IF NOT EXISTS checkout_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid NOT NULL REFERENCES checkouts(id),
  seller_id text NOT NULL,
  customer_name text,
  customer_email text,
  customer_phone text,
  amount numeric NOT NULL,
  vat_amount numeric NOT NULL DEFAULT 0,
  base_amount numeric,
  currency text NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'pending',
  payment_url text,
  payment_reference text,
  download_token text,
  download_expires_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS checkout_orders_checkout_id_idx ON checkout_orders(checkout_id);
CREATE INDEX IF NOT EXISTS checkout_orders_download_token_idx ON checkout_orders(download_token);

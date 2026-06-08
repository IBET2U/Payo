CREATE TABLE IF NOT EXISTS community_posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  freelancer_id text,
  post_type text NOT NULL DEFAULT 'win',
  amount numeric,
  currency text,
  tier text DEFAULT 'BRONZE',
  city text,
  message text NOT NULL,
  is_anonymous boolean DEFAULT true,
  display_name text,
  green_count integer DEFAULT 0,
  fire_count integer DEFAULT 0,
  clap_count integer DEFAULT 0,
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_posts_created_at_idx
  ON community_posts (created_at DESC);

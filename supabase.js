const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error(
    'Missing Supabase config. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (service role key from Supabase → Settings → API). Do not use the anon key here.'
  );
}

// Service role bypasses RLS — required for this Express backend (Clerk auth is enforced in server.js).
const supabase = createClient(supabaseUrl, serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    transport: ws,
  },
});

module.exports = supabase;

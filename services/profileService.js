const supabase = require('../supabase');

async function getProfile(userId) {
  const { data, error } = await supabase
    .from('freelancer_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function pickField(data, existing, key, maxLen) {
  if (data[key] === undefined) return existing?.[key] ?? null;
  const val = String(data[key] ?? '').trim();
  if (!val) return null;
  return maxLen ? val.slice(0, maxLen) : val;
}

async function createOrUpdateProfile(userId, data = {}) {
  const existing = await getProfile(userId);

  const record = {
    id: userId,
    email: data.email !== undefined ? (String(data.email || '').trim().toLowerCase().slice(0, 200) || null) : (existing?.email ?? null),
    name: data.name !== undefined ? (String(data.name || '').trim().slice(0, 100) || null) : (existing?.name ?? null),
    wallet_address: data.wallet_address !== undefined ? (String(data.wallet_address || '').trim().slice(0, 120) || null) : (existing?.wallet_address ?? null),
    phone: data.phone !== undefined ? (String(data.phone || '').trim().replace(/[^\d+]/g, '').slice(0, 20) || null) : (existing?.phone ?? null),
    language: data.language !== undefined ? (String(data.language || 'english').trim().slice(0, 20) || 'english') : (existing?.language ?? 'english'),
    business_name: pickField(data, existing, 'business_name', 100),
    business_address: pickField(data, existing, 'business_address', 300),
    business_phone: pickField(data, existing, 'business_phone', 30),
    business_website: pickField(data, existing, 'business_website', 200),
    invoice_color: data.invoice_color !== undefined
      ? (String(data.invoice_color || '').trim().slice(0, 7) || '#00a884')
      : (existing?.invoice_color ?? '#00a884'),
    invoice_note: data.invoice_note !== undefined
      ? (String(data.invoice_note || '').trim().slice(0, 500) || null)
      : (existing?.invoice_note ?? null),
    logo_url: data.logo_url !== undefined
      ? (String(data.logo_url || '').trim().slice(0, 500) || null)
      : (existing?.logo_url ?? null),
  };

  const { data: profile, error } = await supabase
    .from('freelancer_profiles')
    .upsert(record, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;
  return profile;
}

async function updateLogoUrl(userId, logoUrl) {
  return createOrUpdateProfile(userId, { logo_url: logoUrl });
}

async function hasWalletAddress(userId) {
  const profile = await getProfile(userId);
  return !!(profile?.wallet_address && String(profile.wallet_address).trim());
}

module.exports = {
  getProfile,
  createOrUpdateProfile,
  updateLogoUrl,
  hasWalletAddress,
};

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

async function createOrUpdateProfile(userId, data = {}) {
  const record = {
    id: userId,
    email: data.email ?? null,
    name: data.name ?? null,
    wallet_address: data.wallet_address ?? null,
    phone: data.phone ?? null,
    language: data.language ?? 'english',
  };

  const { data: profile, error } = await supabase
    .from('freelancer_profiles')
    .upsert(record, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;
  return profile;
}

async function hasWalletAddress(userId) {
  const profile = await getProfile(userId);
  return !!(profile?.wallet_address && String(profile.wallet_address).trim());
}

module.exports = {
  getProfile,
  createOrUpdateProfile,
  hasWalletAddress,
};

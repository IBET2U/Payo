const axios = require('axios');
const supabase = require('../supabase');
const { getProfile } = require('./profileService');

function paystackClient() {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured');
  }

  return axios.create({
    baseURL: 'https://api.paystack.co',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

function paystackErrorMessage(err) {
  return err.response?.data?.message || err.message || 'Paystack request failed';
}

async function getBanks() {
  const ps = paystackClient();
  const { data } = await ps.get('/bank', {
    params: { currency: 'NGN', perPage: 100 },
  });

  if (!data?.status) {
    throw new Error(data?.message || 'Failed to load banks');
  }

  return (data.data || []).map((bank) => ({
    name: bank.name,
    code: bank.code,
  }));
}

async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const acct = String(accountNumber || '').trim();
    const code = String(bankCode || '').trim();

    if (!acct || !code) {
      return null;
    }

    const ps = paystackClient();
    const { data } = await ps.get('/bank/resolve', {
      params: {
        account_number: acct,
        bank_code: code,
      },
    });

    if (!data?.status || !data.data?.account_name) {
      return null;
    }

    return {
      account_name: data.data.account_name,
      account_number: data.data.account_number || acct,
    };
  } catch (err) {
    console.warn('[Subaccount] verifyBankAccount failed:', paystackErrorMessage(err));
    return null;
  }
}

async function createSubaccount(userId, { accountNumber, bankCode, businessName, email }) {
  const account_number = String(accountNumber || '').trim();
  const bank_code = String(bankCode || '').trim();
  const business_name = String(businessName || '').trim();

  if (!bank_code || !account_number) {
    throw new Error('bank_code and account_number are required');
  }

  const profile = await getProfile(userId);
  const freelancerEmail = email || profile?.email || null;

  if (!freelancerEmail) {
    throw new Error('Freelancer email is required to create a subaccount');
  }

  const resolvedBusinessName =
    business_name || profile?.business_name || profile?.name || 'Payo Freelancer';

  const verified = await verifyBankAccount(account_number, bank_code);
  if (!verified?.account_name) {
    throw new Error('Could not verify bank account. Check account number and bank.');
  }

  let bankName = null;
  try {
    const banks = await getBanks();
    bankName = banks.find((b) => b.code === bank_code)?.name || null;
  } catch {
    // non-fatal
  }

  const ps = paystackClient();
  const { data } = await ps.post('/subaccount', {
    business_name: resolvedBusinessName,
    settlement_bank: bank_code,
    account_number,
    percentage_charge: 99,
    primary_contact_email: freelancerEmail,
  });

  if (!data?.status) {
    throw new Error(data?.message || 'Failed to create Paystack subaccount');
  }

  const subaccount_code = data.data?.subaccount_code;
  if (!subaccount_code) {
    throw new Error('Paystack did not return a subaccount_code');
  }

  // Save subaccount_code to freelancer_profiles immediately — payment routing
  // depends on this field. If it doesn't persist, Naira payments fall back to
  // the main Paystack account.
  let { data: updatedProfile, error } = await supabase
    .from('freelancer_profiles')
    .upsert(
      {
        id: userId,
        email: freelancerEmail,
        name: profile?.name || resolvedBusinessName,
        business_name: resolvedBusinessName,
        subaccount_code,
        bank_code,
        bank_name: bankName,
        bank_account_number: account_number,
        bank_account_name: verified.account_name,
      },
      { onConflict: 'id' }
    )
    .select()
    .single();

  if (error) throw error;

  if (updatedProfile?.subaccount_code !== subaccount_code) {
    const { data: retriedProfile, error: retryError } = await supabase
      .from('freelancer_profiles')
      .update({ subaccount_code })
      .eq('id', userId)
      .select()
      .single();

    if (retryError) throw retryError;
    updatedProfile = retriedProfile;
  }

  if (updatedProfile?.subaccount_code !== subaccount_code) {
    throw new Error(
      'Subaccount was created on Paystack but could not be saved to your profile. Please try again.'
    );
  }

  return {
    subaccount_code,
    account_name: verified.account_name,
    bank_name: bankName,
    profile: updatedProfile,
  };
}

module.exports = {
  createSubaccount,
  getBanks,
  verifyBankAccount,
};

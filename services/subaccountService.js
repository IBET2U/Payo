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
    code: String(bank.code),
  }));
}

async function verifyBankAccount(accountNumber, bankCode) {
  const acct = String(accountNumber || '').trim();
  const code = String(bankCode || '').trim();

  if (!acct || !code) {
    throw new Error('Account number and bank are required');
  }

  try {
    const ps = paystackClient();
    const { data } = await ps.get('/bank/resolve', {
      params: {
        account_number: acct,
        bank_code: code,
      },
    });

    if (!data?.status || !data.data?.account_name) {
      throw new Error(data?.message || 'Could not verify account. Check account number and bank.');
    }

    return {
      account_name: data.data.account_name,
      account_number: data.data.account_number || acct,
    };
  } catch (err) {
    const message = paystackErrorMessage(err);
    console.warn('[Subaccount] verifyBankAccount failed:', message);
    throw new Error(message);
  }
}

async function resolveAccountName(accountNumber, bankCode, fallbackName) {
  try {
    const verified = await verifyBankAccount(accountNumber, bankCode);
    return verified.account_name;
  } catch (err) {
    console.warn('[Subaccount] resolve skipped, using fallback name:', err.message);
    return fallbackName;
  }
}

async function lookupBankName(bankCode) {
  try {
    const banks = await getBanks();
    return banks.find((b) => String(b.code) === String(bankCode))?.name || null;
  } catch {
    return null;
  }
}

async function persistBankProfile(userId, profileRecord) {
  let { data: updatedProfile, error } = await supabase
    .from('freelancer_profiles')
    .upsert(profileRecord, { onConflict: 'id' })
    .select()
    .single();

  if (error && /business_name/i.test(error.message || '')) {
    console.warn(
      '[Subaccount] business_name column missing, saving without it. Run supabase/migrations/add_business_name.sql'
    );
    const { business_name: _omit, ...recordWithoutBusinessName } = profileRecord;
    ({ data: updatedProfile, error } = await supabase
      .from('freelancer_profiles')
      .upsert(recordWithoutBusinessName, { onConflict: 'id' })
      .select()
      .single());
  }

  if (error) throw error;

  const subaccount_code = profileRecord.subaccount_code;
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

  return updatedProfile;
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

  const account_name = await resolveAccountName(
    account_number,
    bank_code,
    profile?.bank_account_name || resolvedBusinessName
  );
  const bankName = await lookupBankName(bank_code);

  const ps = paystackClient();
  let data;
  try {
    ({ data } = await ps.post('/subaccount', {
      business_name: resolvedBusinessName,
      settlement_bank: bank_code,
      account_number,
      percentage_charge: 99,
      primary_contact_email: freelancerEmail,
    }));
  } catch (err) {
    throw new Error(paystackErrorMessage(err));
  }

  if (!data?.status) {
    throw new Error(data?.message || 'Failed to create Paystack subaccount');
  }

  const subaccount_code = data.data?.subaccount_code;
  if (!subaccount_code) {
    throw new Error('Paystack did not return a subaccount_code');
  }

  const profileRecord = {
    id: userId,
    email: freelancerEmail,
    name: profile?.name || resolvedBusinessName,
    business_name: resolvedBusinessName,
    subaccount_code,
    bank_code,
    bank_name: bankName,
    bank_account_number: account_number,
    bank_account_name: account_name,
  };

  const updatedProfile = await persistBankProfile(userId, profileRecord);

  return {
    subaccount_code,
    account_name,
    bank_name: bankName,
    profile: updatedProfile,
  };
}

async function updateSubaccount(userId, subaccountCode, { accountNumber, bankCode, businessName, email }) {
  const account_number = String(accountNumber || '').trim();
  const bank_code = String(bankCode || '').trim();
  const business_name = String(businessName || '').trim();
  const code = String(subaccountCode || '').trim();

  if (!code) {
    throw new Error('subaccount_code is required to update bank details');
  }
  if (!bank_code || !account_number) {
    throw new Error('bank_code and account_number are required');
  }

  const profile = await getProfile(userId);
  const freelancerEmail = email || profile?.email || null;
  if (!freelancerEmail) {
    throw new Error('Freelancer email is required to update a subaccount');
  }

  const resolvedBusinessName =
    business_name || profile?.business_name || profile?.name || 'Payo Freelancer';

  const account_name = await resolveAccountName(
    account_number,
    bank_code,
    profile?.bank_account_name || resolvedBusinessName
  );
  const bankName = await lookupBankName(bank_code);

  const ps = paystackClient();
  let data;
  try {
    ({ data } = await ps.put(`/subaccount/${encodeURIComponent(code)}`, {
      business_name: resolvedBusinessName,
      settlement_bank: bank_code,
      account_number,
      percentage_charge: 99,
    }));
  } catch (err) {
    throw new Error(paystackErrorMessage(err));
  }

  if (!data?.status) {
    throw new Error(data?.message || 'Failed to update Paystack subaccount');
  }

  const profileRecord = {
    id: userId,
    email: freelancerEmail,
    name: profile?.name || resolvedBusinessName,
    business_name: resolvedBusinessName,
    subaccount_code: code,
    bank_code,
    bank_name: bankName,
    bank_account_number: account_number,
    bank_account_name: account_name,
  };

  const updatedProfile = await persistBankProfile(userId, profileRecord);

  return {
    subaccount_code: code,
    account_name,
    bank_name: bankName,
    profile: updatedProfile,
  };
}

async function saveBankDetails(userId, { accountNumber, bankCode, businessName, email }) {
  const profile = await getProfile(userId);
  const existingCode = profile?.subaccount_code && String(profile.subaccount_code).trim();
  if (existingCode) {
    return updateSubaccount(userId, existingCode, {
      accountNumber,
      bankCode,
      businessName,
      email,
    });
  }
  return createSubaccount(userId, { accountNumber, bankCode, businessName, email });
}

module.exports = {
  createSubaccount,
  updateSubaccount,
  saveBankDetails,
  getBanks,
  verifyBankAccount,
};

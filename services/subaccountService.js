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
    params: { country: 'nigeria', perPage: 100 },
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
  const acct = String(accountNumber || '').trim();
  const code = String(bankCode || '').trim();

  if (!acct || !code) {
    throw new Error('account_number and bank_code are required');
  }

  const ps = paystackClient();
  const { data } = await ps.get('/bank/resolve', {
    params: {
      account_number: acct,
      bank_code: code,
    },
  });

  if (!data?.status) {
    throw new Error(data?.message || 'Could not verify account');
  }

  return {
    account_name: data.data?.account_name || null,
    account_number: data.data?.account_number || acct,
    bank_id: data.data?.bank_id || null,
  };
}

async function createSubaccount(userId, bankDetails = {}) {
  const bankCode = String(bankDetails.bankCode || bankDetails.bank_code || '').trim();
  const accountNumber = String(
    bankDetails.accountNumber || bankDetails.account_number || ''
  ).trim();
  const businessName = String(
    bankDetails.businessName || bankDetails.business_name || ''
  ).trim();

  if (!bankCode || !accountNumber) {
    throw new Error('bank_code and account_number are required');
  }

  const profile = await getProfile(userId);
  const freelancerName =
    businessName || profile?.name || profile?.business_name || 'Payo Freelancer';
  const freelancerEmail =
    bankDetails.freelancerEmail ||
    bankDetails.email ||
    profile?.email ||
    null;

  if (!freelancerEmail) {
    throw new Error('Freelancer email is required to create a subaccount');
  }

  let accountName = bankDetails.accountName || bankDetails.account_name || null;
  if (!accountName) {
    const verified = await verifyBankAccount(accountNumber, bankCode);
    accountName = verified.account_name;
  }

  const ps = paystackClient();
  const { data } = await ps.post('/subaccount', {
    business_name: freelancerName,
    settlement_bank: bankCode,
    account_number: accountNumber,
    percentage_charge: 99,
    primary_contact_email: freelancerEmail,
  });

  if (!data?.status) {
    throw new Error(data?.message || 'Failed to create Paystack subaccount');
  }

  const subaccountCode = data.data?.subaccount_code;
  if (!subaccountCode) {
    throw new Error('Paystack did not return a subaccount_code');
  }

  const { data: updatedProfile, error } = await supabase
    .from('freelancer_profiles')
    .upsert(
      {
        id: userId,
        email: freelancerEmail,
        name: profile?.name || freelancerName,
        business_name: freelancerName,
        subaccount_code: subaccountCode,
        bank_code: bankCode,
        bank_account_number: accountNumber,
        bank_account_name: accountName,
      },
      { onConflict: 'id' }
    )
    .select()
    .single();

  if (error) throw error;

  return {
    subaccount_code: subaccountCode,
    account_name: accountName,
    profile: updatedProfile,
  };
}

module.exports = {
  createSubaccount,
  getBanks,
  verifyBankAccount,
};

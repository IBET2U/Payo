const express = require('express');
const { clerkClient } = require('@clerk/clerk-sdk-node');
const router = express.Router();
const {
  getProfile,
  createOrUpdateProfile,
} = require('../services/profileService');

// New users often hit bank setup before any profile row exists, and Clerk
// session claims don't carry an email — resolve it from every source we have.
async function resolveUserEmail(req, existingProfile, bodyEmail) {
  const candidates = [
    existingProfile?.email,
    bodyEmail,
    req.auth?.sessionClaims?.email,
  ];

  for (const candidate of candidates) {
    const email = String(candidate || '').trim().toLowerCase();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  }

  try {
    const user = await clerkClient.users.getUser(req.auth.userId);
    const clerkEmail =
      user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress || user?.emailAddresses?.[0]?.emailAddress;
    if (clerkEmail) return String(clerkEmail).trim().toLowerCase();
  } catch (err) {
    console.warn('[Profile] Clerk email lookup failed:', err.message);
  }

  return null;
}
const {
  createSubaccount,
  getBanks,
  verifyBankAccount,
} = require('../services/subaccountService');

router.get('/', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const profile = await getProfile(userId);

    res.json({
      success: true,
      profile: profile || null,
      has_wallet: !!(profile?.wallet_address && String(profile.wallet_address).trim()),
      has_bank: !!(profile?.subaccount_code && String(profile.subaccount_code).trim()),
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/verify-bank', async (req, res) => {
  try {
    const { account_number, bank_code } = req.query;
    const result = await verifyBankAccount(account_number, bank_code);

    if (!result?.account_name) {
      return res.status(400).json({
        success: false,
        error: 'Could not verify account. Check account number and bank.',
      });
    }

    res.json({
      success: true,
      account_name: result.account_name,
      account_number: result.account_number,
    });
  } catch (error) {
    console.error('[Profile] Verify bank error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/banks', async (req, res) => {
  try {
    const banks = await getBanks();
    res.json({ success: true, banks });
  } catch (error) {
    console.error('[Profile] Get banks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/bank/verify', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const { account_number, bank_code } = req.body || {};
    const result = await verifyBankAccount(account_number, bank_code);

    if (!result?.account_name) {
      return res.status(400).json({
        success: false,
        error: 'Could not verify account. Check account number and bank.',
      });
    }

    res.json({
      success: true,
      account_name: result.account_name,
      account_number: result.account_number,
    });
  } catch (error) {
    console.error('[Profile] Verify bank error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/bank', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const raw = req.body || {};
    const bank_code = String(raw.bank_code || '').trim().slice(0, 10);
    const account_number = String(raw.account_number || '').trim().replace(/\D/g, '').slice(0, 10);
    const business_name = String(raw.business_name || '').trim().slice(0, 100);

    if (!bank_code || !account_number) {
      return res.status(400).json({
        success: false,
        error: 'bank_code and account_number are required',
      });
    }

    const existing = await getProfile(userId);
    const email = await resolveUserEmail(req, existing, raw.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'We could not find your email. Please update your profile and try again.',
      });
    }

    const verified = await verifyBankAccount(account_number, bank_code);
    if (!verified?.account_name) {
      return res.status(400).json({
        success: false,
        error: 'Could not verify bank account. Please verify before saving.',
      });
    }

    const result = await createSubaccount(userId, {
      accountNumber: account_number,
      bankCode: bank_code,
      businessName: business_name,
      email,
    });

    res.json({
      success: true,
      subaccount_code: result.subaccount_code,
      account_name: result.account_name,
      bank_name: result.bank_name,
      profile: result.profile,
      has_bank: true,
    });
  } catch (error) {
    console.error('[Profile] Save bank error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const { wallet_address, phone, name, email, language } = req.body;

    const existing = await getProfile(userId);

    // Resolve (request value → existing → fallback), then sanitize
    const resolvedEmail = email ?? existing?.email ?? req.auth?.sessionClaims?.email ?? null;
    const resolvedName = name ?? existing?.name ?? null;
    const resolvedPhone = phone !== undefined ? phone : existing?.phone ?? null;
    const resolvedWallet =
      wallet_address !== undefined ? wallet_address : existing?.wallet_address ?? null;
    const resolvedLanguage = language ?? existing?.language ?? 'english';

    const safeName = String(resolvedName || '').trim().slice(0, 100);
    const safeEmail = String(resolvedEmail || '').trim().toLowerCase().slice(0, 200);
    const safePhone = String(resolvedPhone || '').trim().replace(/[^\d+]/g, '').slice(0, 20);
    const safeWallet = String(resolvedWallet || '').trim().slice(0, 120);
    const safeLanguage = String(resolvedLanguage || 'english').trim().slice(0, 20);

    if (safeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
      return res.status(400).json({ success: false, error: 'A valid email is required' });
    }

    const profile = await createOrUpdateProfile(userId, {
      email: safeEmail || null,
      name: safeName || null,
      wallet_address: safeWallet || null,
      phone: safePhone || null,
      language: safeLanguage || 'english',
    });

    res.json({
      success: true,
      profile,
      has_wallet: !!(profile?.wallet_address && String(profile.wallet_address).trim()),
      has_bank: !!(profile?.subaccount_code && String(profile.subaccount_code).trim()),
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

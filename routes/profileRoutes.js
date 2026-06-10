const express = require('express');
const router = express.Router();
const {
  getProfile,
  createOrUpdateProfile,
} = require('../services/profileService');
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

    const { bank_code, account_number, business_name } = req.body || {};
    const existing = await getProfile(userId);

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
      email: existing?.email || req.auth?.sessionClaims?.email || null,
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
    const profile = await createOrUpdateProfile(userId, {
      email: email ?? existing?.email ?? req.auth?.sessionClaims?.email ?? null,
      name: name ?? existing?.name ?? null,
      wallet_address: wallet_address !== undefined ? wallet_address : existing?.wallet_address ?? null,
      phone: phone !== undefined ? phone : existing?.phone ?? null,
      language: language ?? existing?.language ?? 'english',
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

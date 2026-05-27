const express = require('express');
const router = express.Router();
const {
  getProfile,
  createOrUpdateProfile,
} = require('../services/profileService');

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
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: error.message });
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
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

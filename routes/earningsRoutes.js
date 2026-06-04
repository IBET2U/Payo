const express = require('express');
const router = express.Router();
const { getProfile } = require('../services/profileService');
const {
  getNextTierInfo,
  TIER_EARNINGS_RATES,
} = require('../services/earningsService');

router.get('/progress', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const profile = await getProfile(userId);
    const monthlyVolume = Number(profile?.monthly_volume ?? 0);
    const monthlyEarnings = Number(profile?.monthly_earnings ?? 0);
    const tier = profile?.tier || 'BRONZE';
    const progress = getNextTierInfo(monthlyVolume);
    const currentTier = progress.currentTier || tier;
    const nextTier = progress.nextTier;

    res.json({
      success: true,
      currentTier,
      nextTier,
      amountNeeded: progress.amountNeeded,
      percentageProgress: progress.percentageProgress,
      monthlyEarnings,
      monthlyVolume,
      earningsRateIncrease: progress.earningsRateIncrease,
      currentEarningsRatePercent: (TIER_EARNINGS_RATES[currentTier] ?? 0.002) * 100,
      nextEarningsRatePercent: nextTier
        ? (TIER_EARNINGS_RATES[nextTier] ?? 0) * 100
        : null,
    });
  } catch (error) {
    console.error('[Earnings] Progress error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

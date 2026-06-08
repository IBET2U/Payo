const supabase = require('../supabase');
const {
  sendMonthlyEarningsSummaryWhatsApp,
  sendMonthlyEarningsCreditedWhatsApp,
} = require('../whatsapp');

const USD_TO_NGN = 1600;
const TIMEZONE = process.env.TZ || 'Africa/Lagos';

const TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];

const TIER_THRESHOLDS = {
  BRONZE: 0,
  SILVER: 100_000,
  GOLD: 500_000,
  PLATINUM: 2_000_000,
  DIAMOND: 10_000_000,
};

const TIER_EARNINGS_RATES = {
  BRONZE: 0.002,
  SILVER: 0.004,
  GOLD: 0.006,
  PLATINUM: 0.008,
  DIAMOND: 0.01,
};

const NETWORK_MULTIPLIERS = {
  BRONZE: 1,
  SILVER: 1.2,
  GOLD: 1.5,
  PLATINUM: 2,
  DIAMOND: 3,
};

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function normalizeCurrency(currency) {
  return String(currency || 'NGN').toUpperCase().trim() === 'USD' ? 'USD' : 'NGN';
}

function toNgnAmount(amount, currency) {
  const amt = toNumber(amount);
  if (amt <= 0) return 0;
  return normalizeCurrency(currency) === 'USD' ? amt * USD_TO_NGN : amt;
}

function calculateTier(monthlyVolume) {
  const volume = toNumber(monthlyVolume);
  if (volume >= TIER_THRESHOLDS.DIAMOND) return 'DIAMOND';
  if (volume >= TIER_THRESHOLDS.PLATINUM) return 'PLATINUM';
  if (volume >= TIER_THRESHOLDS.GOLD) return 'GOLD';
  if (volume >= TIER_THRESHOLDS.SILVER) return 'SILVER';
  return 'BRONZE';
}

function calculateTransactionEarnings(amount, currency, tier) {
  const tierName = TIERS.includes(tier) ? tier : 'BRONZE';
  const ngnAmount = toNgnAmount(amount, currency);
  const rate = TIER_EARNINGS_RATES[tierName] ?? TIER_EARNINGS_RATES.BRONZE;
  return roundMoney(ngnAmount * rate);
}

function calculateNetworkEarnings(transactionEarnings, tier) {
  const tierName = TIERS.includes(tier) ? tier : 'BRONZE';
  const base = toNumber(transactionEarnings);
  const multiplier = NETWORK_MULTIPLIERS[tierName] ?? 1;
  if (base <= 0 || multiplier <= 1) return 0;
  return roundMoney(base * (multiplier - 1));
}

function getNextTierInfo(currentVolume) {
  const volume = toNumber(currentVolume);
  const currentTier = calculateTier(volume);
  const currentIndex = TIERS.indexOf(currentTier);

  if (currentTier === 'DIAMOND') {
    return {
      currentTier,
      nextTier: null,
      amountNeeded: 0,
      percentageProgress: 100,
      earningsRateIncrease: 0,
    };
  }

  const nextTier = TIERS[currentIndex + 1];
  const currentMin = TIER_THRESHOLDS[currentTier];
  const nextMin = TIER_THRESHOLDS[nextTier];
  const amountNeeded = Math.max(0, nextMin - volume);
  const span = nextMin - currentMin;
  const percentageProgress =
    span > 0 ? Math.min(100, Math.max(0, roundMoney(((volume - currentMin) / span) * 100))) : 0;

  return {
    currentTier,
    nextTier,
    amountNeeded: roundMoney(amountNeeded),
    percentageProgress,
    earningsRateIncrease: roundMoney(
      (TIER_EARNINGS_RATES[nextTier] - TIER_EARNINGS_RATES[currentTier]) * 100
    ),
  };
}

function getMonthKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).format(date);
}

function getPreviousMonthLabel(date = new Date()) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(12, 0, 0, 0);
  d.setMonth(d.getMonth() - 1);
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: TIMEZONE,
    month: 'long',
    year: 'numeric',
  }).format(d);
}

async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('freelancer_profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('[Earnings] fetchProfile failed:', error.message);
    return null;
  }
  if (!data) {
    console.error(`[Earnings] Freelancer profile not found: ${userId}`);
    return null;
  }
  return data;
}

async function updateUserEarnings(userId, transactionAmount, currency, options = {}) {
  console.log('[EARNINGS] updateUserEarnings called with:', {
    userId,
    transactionAmount,
    currency,
  });

  const { isNetworkTransaction = false } = options;
  const profile = await fetchProfile(userId);
  if (!profile) return null;

  const volumeNgn = toNgnAmount(transactionAmount, currency);
  const previousVolume = toNumber(profile.monthly_volume);
  const newVolume = roundMoney(previousVolume + volumeNgn);
  const newTier = calculateTier(newVolume);

  const transactionEarnings = calculateTransactionEarnings(
    transactionAmount,
    currency,
    newTier
  );
  const networkEarnings = isNetworkTransaction
    ? calculateNetworkEarnings(transactionEarnings, newTier)
    : 0;
  const earningsDelta = roundMoney(transactionEarnings + networkEarnings);

  const updatePayload = {
    monthly_volume: newVolume,
    tier: newTier,
    monthly_earnings: roundMoney(toNumber(profile.monthly_earnings) + earningsDelta),
    monthly_transaction_earnings: roundMoney(
      toNumber(profile.monthly_transaction_earnings) + transactionEarnings
    ),
    monthly_network_earnings: roundMoney(
      toNumber(profile.monthly_network_earnings) + networkEarnings
    ),
    total_earnings: roundMoney(toNumber(profile.total_earnings) + earningsDelta),
  };

  const { data: updated, error } = await supabase
    .from('freelancer_profiles')
    .update(updatePayload)
    .eq('id', userId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[Earnings] updateUserEarnings failed:', error.message);
    return null;
  }
  if (!updated) {
    console.error(`[Earnings] updateUserEarnings returned no profile for: ${userId}`);
    return null;
  }

  return {
    profile: updated,
    tier: newTier,
    earningsThisTransaction: earningsDelta,
    transactionEarnings,
    networkEarnings,
    tierChanged: (profile.tier || 'BRONZE') !== newTier,
    nextTierInfo: getNextTierInfo(newVolume),
  };
}

async function creditMonthlyEarnings(userId) {
  const profile = await fetchProfile(userId);
  if (!profile) return null;

  const amount = roundMoney(profile.monthly_earnings);

  if (amount <= 0) {
    return { profile, credited: 0 };
  }

  const newBalance = roundMoney(toNumber(profile.wallet_balance) + amount);
  const { data: updated, error } = await supabase
    .from('freelancer_profiles')
    .update({ wallet_balance: newBalance })
    .eq('id', userId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[Earnings] creditMonthlyEarnings update failed:', error.message);
    return null;
  }
  if (!updated) {
    console.error(`[Earnings] creditMonthlyEarnings returned no profile for: ${userId}`);
    return null;
  }

  if (updated.phone) {
    try {
      await sendMonthlyEarningsCreditedWhatsApp(
        updated.phone,
        amount,
        getPreviousMonthLabel()
      );
    } catch (waErr) {
      console.error(
        `[Earnings] creditMonthlyEarnings WhatsApp failed for ${userId}:`,
        waErr.message
      );
    }
  }

  return { profile: updated, credited: amount };
}

async function monthlyReset() {
  console.log('[Payo Earnings] Starting monthly reset...');
  const monthKey = getPreviousMonthLabel();

  const { data: profiles, error } = await supabase
    .from('freelancer_profiles')
    .select(
      'id, phone, tier, monthly_volume, monthly_earnings, monthly_transaction_earnings, monthly_network_earnings, wallet_balance'
    )
    .or('monthly_volume.gt.0,monthly_earnings.gt.0');

  if (error) {
    console.error('[Payo Earnings] Failed to fetch profiles for reset:', error.message);
    throw error;
  }

  const activeProfiles = profiles || [];
  console.log(`[Payo Earnings] Resetting ${activeProfiles.length} profile(s)`);

  for (const profile of activeProfiles) {
    const userId = profile.id;
    const monthlyVolume = roundMoney(profile.monthly_volume);
    const transactionEarnings = roundMoney(profile.monthly_transaction_earnings);
    const networkEarnings = roundMoney(profile.monthly_network_earnings);
    const totalEarnings = roundMoney(profile.monthly_earnings);

    try {
      if (totalEarnings > 0) {
        const creditResult = await creditMonthlyEarnings(userId);
        if (!creditResult) {
          throw new Error('Failed to credit monthly earnings');
        }
      }

      const { error: historyError } = await supabase.from('monthly_earnings_history').insert({
        user_id: userId,
        month: monthKey,
        tier: profile.tier || 'BRONZE',
        monthly_volume: monthlyVolume,
        transaction_earnings: transactionEarnings,
        network_earnings: networkEarnings,
        total_earnings: totalEarnings,
      });

      if (historyError) throw historyError;

      const { error: resetError } = await supabase
        .from('freelancer_profiles')
        .update({
          monthly_volume: 0,
          monthly_earnings: 0,
          monthly_transaction_earnings: 0,
          monthly_network_earnings: 0,
          tier: 'BRONZE',
        })
        .eq('id', userId);

      if (resetError) throw resetError;

      if (profile.phone) {
        try {
          await sendMonthlyEarningsSummaryWhatsApp(profile.phone, {
            month: monthKey,
            tier: profile.tier || 'BRONZE',
            monthlyVolume,
            transactionEarnings,
            networkEarnings,
            totalEarnings,
          });
        } catch (waErr) {
          console.error(
            `[Payo Earnings] Summary WhatsApp failed for ${userId}:`,
            waErr.message
          );
        }
      }

      console.log(
        `[Payo Earnings] Reset complete for ${userId} — volume ₦${monthlyVolume}, earnings ₦${totalEarnings}`
      );
    } catch (err) {
      console.error(`[Payo Earnings] Monthly reset failed for ${userId}:`, err.message);
    }
  }

  console.log('[Payo Earnings] Monthly reset job complete');
}

module.exports = {
  USD_TO_NGN,
  TIERS,
  TIER_THRESHOLDS,
  TIER_EARNINGS_RATES,
  NETWORK_MULTIPLIERS,
  calculateTier,
  calculateTransactionEarnings,
  calculateNetworkEarnings,
  getNextTierInfo,
  updateUserEarnings,
  creditMonthlyEarnings,
  monthlyReset,
  toNgnAmount,
  getMonthKey,
};

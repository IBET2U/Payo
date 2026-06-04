const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const rawWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER || '';
const PAYO_APP_URL =
  process.env.PAYO_APP_URL || 'https://payo-production.up.railway.app';

const fromWhatsAppNumber = rawWhatsAppNumber.startsWith('whatsapp:')
  ? rawWhatsAppNumber
  : rawWhatsAppNumber
    ? `whatsapp:${rawWhatsAppNumber}`
    : '';

let client = null;
if (accountSid && authToken) {
  try {
    client = twilio(accountSid, authToken);
  } catch (err) {
    console.error('[WhatsApp ERROR] Failed to initialize Twilio client:', err.message);
  }
} else {
  console.error('[WhatsApp ERROR] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in environment');
}

const CURRENCY_SYMBOLS = {
  NGN: '₦',
  USD: '$',
};

function getCurrencySymbol(currency) {
  const code = String(currency || 'NGN').toUpperCase();
  return CURRENCY_SYMBOLS[code] || '';
}

function formatAmount(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return String(amount);
  return num.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Normalize Nigerian phone numbers to E.164 (+234...).
 * Returns null and logs an error for unrecognized formats.
 */
function normalizeNigerianPhone(phone) {
  if (phone === null || phone === undefined) {
    console.error('[WhatsApp ERROR] normalizeNigerianPhone: phone is empty');
    return null;
  }

  const digits = String(phone).replace(/[\s\-()]/g, '');

  // Already in E.164 format — any country
  if (/^\+\d{10,15}$/.test(digits)) {
    return digits;
  }

  // Nigerian formats
  if (/^\+234\d{10}$/.test(digits)) return digits;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;

  // US format without plus
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;

  console.error(`[WhatsApp ERROR] normalizeNigerianPhone: unrecognized format "${phone}"`);
  return null;
}

async function sendWhatsAppMessage(toPhone, body, label) {
  if (!client || !fromWhatsAppNumber) {
    console.error(`[WhatsApp ERROR] ${label}: Twilio client or sender number not configured`);
    return null;
  }

  const normalized = normalizeNigerianPhone(toPhone);
  if (!normalized) {
    console.error(`[WhatsApp ERROR] ${label}: invalid phone number "${toPhone}"`);
    return null;
  }

  try {
    const message = await client.messages.create({
      from: fromWhatsAppNumber,
      to: `whatsapp:${normalized}`,
      body,
    });
    console.log(`[WhatsApp] ${label} sent to ${normalized} (sid: ${message.sid})`);
    return message;
  } catch (err) {
    console.error(`[WhatsApp ERROR] ${label}: failed to send to ${normalized} —`, err.message);
    return null;
  }
}

async function sendInvoiceWhatsApp(
  clientPhone,
  clientName,
  freelancerName,
  amount,
  currency,
  dueDate,
  paymentUrl
) {
  const symbol = getCurrencySymbol(currency);
  const formattedAmount = formatAmount(amount);

  const body = `Hello ${clientName} 👋

You have a new invoice from ${freelancerName}.

💰 Amount: ${symbol}${formattedAmount}
📅 Due Date: ${dueDate}
💳 Pay Now: ${paymentUrl}

Powered by Payo — payoapp.org`;

  return sendWhatsAppMessage(clientPhone, body, 'Invoice');
}

async function sendFollowUpWhatsApp(
  clientPhone,
  clientName,
  freelancerName,
  amount,
  currency,
  daysPastDue,
  paymentUrl
) {
  const symbol = getCurrencySymbol(currency);
  const formattedAmount = formatAmount(amount);
  const days = Number(daysPastDue) || 0;

  let body;

  if (days >= 3 && days <= 6) {
    body = `Hi ${clientName} 😊 Just a friendly reminder about your invoice for ${symbol}${formattedAmount} from ${freelancerName}. No stress — click here when you're ready: ${paymentUrl}`;
  } else if (days >= 7 && days <= 13) {
    body = `Hi ${clientName}, your invoice for ${symbol}${formattedAmount} from ${freelancerName} is now ${days} days overdue. Please make payment here: ${paymentUrl}`;
  } else if (days >= 14) {
    body = `${clientName}, this is a final notice. Your invoice for ${symbol}${formattedAmount} from ${freelancerName} is seriously overdue. Please pay immediately: ${paymentUrl} — The Payo Team`;
  } else {
    console.error(
      `[WhatsApp ERROR] Follow-up: daysPastDue=${days} is outside the follow-up window (3+)`
    );
    return null;
  }

  return sendWhatsAppMessage(clientPhone, body, `Follow-up (day ${days})`);
}

async function sendPaymentConfirmedWhatsApp(freelancerPhone, clientName, amount, currency) {
  const symbol = getCurrencySymbol(currency);
  const formattedAmount = formatAmount(amount);

  const body = `🎉 You just got paid!

${clientName} has paid ${symbol}${formattedAmount} through Payo.

Your money is on its way. Keep up the great work! 💪

— The Payo Team`;

  return sendWhatsAppMessage(freelancerPhone, body, 'Payment confirmation');
}

async function sendTierUpgradeWhatsApp(freelancerPhone, newTier, earningsRate, monthlyVolume) {
  const tier = String(newTier || 'BRONZE').toUpperCase();
  const rate = Number(earningsRate);
  const rateDisplay = Number.isFinite(rate) ? rate : earningsRate;
  const volume = formatAmount(monthlyVolume);

  const body = `🎉 Congratulations! You just reached ${tier} status on Payo!

Your new earnings rate: ${rateDisplay}% back on every transaction
Monthly volume so far: ₦${volume}

Keep going — every naira you process earns you more this month. 💚

— The Payo Team`;

  return sendWhatsAppMessage(freelancerPhone, body, 'Tier upgrade');
}

async function sendMonthlyEarningsSummary(
  freelancerPhone,
  month,
  tier,
  totalEarnings,
  nextMonthTip
) {
  const monthLabel = month || 'last month';
  const tierLabel = String(tier || 'BRONZE').toUpperCase();
  const total = formatAmount(totalEarnings);
  const tip = nextMonthTip || 'Keep processing through Payo to grow your tier next month.';

  const body = `💰 Your Payo earnings for ${monthLabel} are ready!

Tier achieved: ${tierLabel}
Total earned: ₦${total}
Credited to your Payo wallet now.

${tip}

Thank you for being part of Payo 💚
— The Payo Team`;

  return sendWhatsAppMessage(freelancerPhone, body, 'Monthly earnings summary');
}

async function sendTierProgressReminder(
  freelancerPhone,
  currentTier,
  nextTier,
  amountNeeded,
  daysLeft,
  nextRate,
  estimatedBonus,
  payoUrl = PAYO_APP_URL
) {
  const current = String(currentTier || 'BRONZE').toUpperCase();
  const next = String(nextTier || '').toUpperCase();
  const needed = formatAmount(amountNeeded);
  const days = Number(daysLeft) || 0;
  const rate = nextRate != null ? Number(nextRate) : null;
  const rateDisplay = Number.isFinite(rate) ? rate : nextRate || '—';
  const bonus =
    estimatedBonus != null ? `₦${formatAmount(estimatedBonus)}` : 'more earnings';
  const url = payoUrl || PAYO_APP_URL;

  const body = `Omo you dey close! 👀

You need just ₦${needed} more to reach ${next} this month.
${days} days remaining.

If you reach ${next} your earnings rate jumps to ${rateDisplay}% —
that's ${bonus} extra in your pocket this month.

Process more through Payo now: ${url}

— The Payo Team`;

  return sendWhatsAppMessage(
    freelancerPhone,
    body,
    `Tier progress reminder (${current} → ${next})`
  );
}

async function sendMonthlyEarningsCreditedWhatsApp(freelancerPhone, amount, monthLabel) {
  const formattedAmount = formatAmount(amount);
  const month = monthLabel || 'last month';

  const body = `Your Payo earnings for ${month}: ₦${formattedAmount} 💚

The amount has been added to your Payo wallet. Keep growing your tier!

— The Payo Team`;

  return sendWhatsAppMessage(freelancerPhone, body, 'Monthly earnings credit');
}

async function sendMonthlyEarningsSummaryWhatsApp(freelancerPhone, summary = {}) {
  const {
    month,
    tier,
    monthlyVolume,
    transactionEarnings,
    networkEarnings,
    totalEarnings,
  } = summary;

  const body = `📊 Payo earnings summary — ${month || 'last month'}

Tier reached: ${tier || 'BRONZE'}
Volume processed: ₦${formatAmount(monthlyVolume || 0)}
Transaction earnings: ₦${formatAmount(transactionEarnings || 0)}
Network earnings: ₦${formatAmount(networkEarnings || 0)}
Total earnings: ₦${formatAmount(totalEarnings || 0)}

Your tier resets to BRONZE this month. Every payment counts — let's go! 💚

— The Payo Team`;

  return sendWhatsAppMessage(freelancerPhone, body, 'Monthly earnings summary (detailed)');
}

module.exports = {
  sendInvoiceWhatsApp,
  sendFollowUpWhatsApp,
  sendPaymentConfirmedWhatsApp,
  sendTierUpgradeWhatsApp,
  sendMonthlyEarningsSummary,
  sendTierProgressReminder,
  sendMonthlyEarningsCreditedWhatsApp,
  sendMonthlyEarningsSummaryWhatsApp,
  normalizeNigerianPhone,
};

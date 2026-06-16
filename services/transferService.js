const axios = require('axios');
const supabase = require('../supabase');
const { normalizeNigerianPhone } = require('../whatsapp');
const { sendPaymentConfirmedWhatsApp } = require('../whatsapp');
const { initializeWalletTopup } = require('../payments');

function looksLikeEmail(value) {
  const v = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function looksLikePhone(value) {
  const v = String(value || '').trim();
  return /[+\d]/.test(v) && /\d{7,}/.test(v);
}

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

async function resolveRecipient(phoneOrEmail, options = {}) {
  const raw = String(phoneOrEmail || '').trim();
  if (!raw) throw new Error('recipient is required');

  if (looksLikeEmail(raw)) {
    const { data: profile, error } = await supabase
      .from('freelancer_profiles')
      .select('*')
      .eq('email', raw)
      .maybeSingle();

    if (error) throw error;
    if (profile) return { type: 'payo', profile };
    return { type: 'external', phoneOrEmail: raw };
  }

  if (looksLikePhone(raw)) {
    const normalized = normalizeNigerianPhone(raw) || raw;
    const { data: profile, error } = await supabase
      .from('freelancer_profiles')
      .select('*')
      .eq('phone', normalized)
      .maybeSingle();

    if (error) throw error;
    if (profile) return { type: 'payo', profile };

    // Optional external verification if bank details provided
    const { accountNumber, bankCode } = options;
    if (accountNumber && bankCode) {
      try {
        const ps = paystackClient();
        const res = await ps.get('/bank/resolve', {
          params: { account_number: accountNumber, bank_code: bankCode },
        });
        return {
          type: 'external',
          phoneOrEmail: raw,
          bank: {
            accountNumber,
            bankCode,
            accountName: res?.data?.data?.account_name || null,
          },
        };
      } catch (err) {
        throw new Error(
          `Paystack bank resolution failed: ${err.response?.data?.message || err.message}`
        );
      }
    }

    return { type: 'external', phoneOrEmail: raw };
  }

  return { type: 'external', phoneOrEmail: raw };
}

function isSchemaColumnError(error) {
  const msg = String(error?.message || '');
  return /schema cache|Could not find the .* column/i.test(msg);
}

function buildTransferInsertAttempts(row) {
  const {
    sender_id,
    recipient_type,
    recipient_id,
    recipient_phone_or_email,
    amount,
    reason,
    status,
    provider,
    provider_reference,
  } = row;

  return [
    {
      sender_id,
      recipient_type,
      recipient_id,
      recipient_phone_or_email,
      amount,
      reason,
      status,
      provider,
      provider_reference,
    },
    {
      sender_id,
      recipient_type,
      recipient_id,
      recipient_phone_or_email,
      amount,
      reason,
      status,
    },
    {
      sender_id,
      recipient_type,
      recipient_phone_or_email,
      amount,
      reason,
      status,
    },
    {
      sender_id,
      recipient_type,
      amount,
      reason,
      status,
    },
    {
      sender_id,
      amount,
      reason,
      status,
    },
    {
      sender_id,
      amount,
      status,
    },
    {
      sender_id,
      amount,
    },
  ];
}

async function insertTransferRecord(row, metadata = {}) {
  const attempts = buildTransferInsertAttempts(row);
  let lastError = null;

  for (const payload of attempts) {
    const cleaned = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined && value !== null)
    );

    const { data, error } = await supabase
      .from('transfers')
      .insert(cleaned)
      .select()
      .maybeSingle();

    if (!error && data) {
      return { ...data, ...metadata };
    }

    if (error && !isSchemaColumnError(error)) {
      throw error;
    }

    lastError = error;
  }

  throw lastError || new Error('Failed to save transfer record');
}

async function createTransferRecipient(accountNumber, bankCode, name) {
  if (!accountNumber || !bankCode) {
    throw new Error('accountNumber and bankCode are required');
  }

  const ps = paystackClient();
  const payload = {
    type: 'nuban',
    name: name || 'Payo Recipient',
    account_number: String(accountNumber),
    bank_code: String(bankCode),
    currency: 'NGN',
  };

  const res = await ps.post('/transferrecipient', payload);
  const code = res?.data?.data?.recipient_code;
  if (!code) {
    throw new Error('Paystack transferrecipient did not return recipient_code');
  }
  return code;
}

const MAX_TRANSFER_AMOUNT = 10000000;

async function initiateTransfer(senderId, recipientDetails, amount, reason, options = {}) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('A valid positive amount is required');
  }
  if (amt > MAX_TRANSFER_AMOUNT) {
    throw new Error('Transfer amount exceeds the maximum limit of ₦10,000,000.');
  }

  let { data: sender, error: senderError } = await supabase
    .from('freelancer_profiles')
    .select('id, name, phone, email, wallet_balance')
    .eq('id', senderId)
    .maybeSingle();

  if (senderError) {
    console.error('[Transfer] Sender lookup failed:', senderError.message);
    throw new Error('Failed to look up sender profile');
  }
  if (!sender) {
    const { data: newProfile, error: createError } = await supabase
      .from('freelancer_profiles')
      .insert({
        id: senderId,
        wallet_balance: 0,
        monthly_volume: 0,
        monthly_earnings: 0,
        total_earnings: 0,
        tier: 'BRONZE',
      })
      .select()
      .single();
    if (createError) throw createError;
    sender = newProfile;
  }

  // Sender must have the funds — block overdrafts and debit before sending
  const senderBalanceBeforeDebit = Number(sender.wallet_balance || 0);
  if (senderBalanceBeforeDebit < amt) {
    throw new Error(
      `Insufficient balance. Your wallet balance is ₦${senderBalanceBeforeDebit.toLocaleString('en-NG')}.`
    );
  }

  // Conditional debit: the .gte guard prevents the balance going negative
  // even if two transfers race each other.
  const { data: debited, error: debitError } = await supabase
    .from('freelancer_profiles')
    .update({ wallet_balance: senderBalanceBeforeDebit - amt })
    .eq('id', senderId)
    .gte('wallet_balance', amt)
    .select('id')
    .maybeSingle();

  if (debitError) throw debitError;
  if (!debited) {
    throw new Error('Insufficient balance. Please refresh and try again.');
  }

  let transferRecord = null;
  const status = 'success';
  let provider = 'internal';
  let providerReference = null;
  let recipientBalanceBeforeCredit = null;
  let payoRecipientId = null;
  let senderDebited = true;

  try {
    if (recipientDetails.type === 'payo') {
      const recipient = recipientDetails.profile;
      if (!recipient?.id) {
        throw new Error('Payo recipient profile is missing');
      }

      payoRecipientId = recipient.id;
      recipientBalanceBeforeCredit = Number(recipient.wallet_balance || 0);

      const { error: creditError } = await supabase
        .from('freelancer_profiles')
        .update({ wallet_balance: recipientBalanceBeforeCredit + amt })
        .eq('id', recipient.id);

      if (creditError) throw creditError;

      provider = 'payo';
      providerReference = `payo_${Date.now()}`;

      transferRecord = await insertTransferRecord(
        {
          sender_id: senderId,
          recipient_type: 'payo',
          recipient_id: recipient.id,
          recipient_phone_or_email: recipient.email || recipient.phone || null,
          amount: amt,
          reason: reason || null,
          status,
          provider,
          provider_reference: providerReference,
        },
        {
          recipient_type: 'payo',
          recipient_id: recipient.id,
          recipient_phone_or_email: recipient.email || recipient.phone || null,
          provider,
          provider_reference: providerReference,
        }
      );

      const toPhone = recipient.phone || recipientDetails.phoneOrEmail;
      if (toPhone) {
        try {
          await sendPaymentConfirmedWhatsApp(
            toPhone,
            sender.name || sender.email || 'Someone',
            amt,
            'NGN'
          );
        } catch (waErr) {
          console.error('[Transfer] WhatsApp notification failed:', waErr.message);
        }
      }
    } else if (recipientDetails.type === 'external') {
      provider = 'paystack';
      const { accountNumber, bankCode, name } = options;

      if (!accountNumber || !bankCode) {
        throw new Error('Bank details required for external transfer');
      }

      const recipientCode = await createTransferRecipient(accountNumber, bankCode, name);

      const ps = paystackClient();
      const res = await ps.post('/transfer', {
        source: 'balance',
        amount: Math.round(amt * 100),
        recipient: recipientCode,
        reason: reason || undefined,
      });

      providerReference =
        res?.data?.data?.transfer_code || res?.data?.data?.reference || recipientCode;

      transferRecord = await insertTransferRecord(
        {
          sender_id: senderId,
          recipient_type: 'external',
          recipient_phone_or_email: recipientDetails.phoneOrEmail || null,
          amount: amt,
          reason: reason || null,
          status,
          provider,
          provider_reference: providerReference,
        },
        {
          recipient_type: 'external',
          recipient_phone_or_email: recipientDetails.phoneOrEmail || null,
          provider,
          provider_reference: providerReference,
        }
      );

      if (recipientDetails.phoneOrEmail) {
        try {
          await sendPaymentConfirmedWhatsApp(
            recipientDetails.phoneOrEmail,
            sender.name || sender.email || 'Someone',
            amt,
            'NGN'
          );
        } catch (waErr) {
          console.error('[Transfer] WhatsApp notification failed:', waErr.message);
        }
      }
    } else {
      throw new Error('Invalid recipient type');
    }
  } catch (err) {
    if (payoRecipientId != null && recipientBalanceBeforeCredit != null) {
      await supabase
        .from('freelancer_profiles')
        .update({ wallet_balance: recipientBalanceBeforeCredit })
        .eq('id', payoRecipientId);
    }
    if (senderDebited) {
      try {
        const { data: current } = await supabase
          .from('freelancer_profiles')
          .select('wallet_balance')
          .eq('id', senderId)
          .maybeSingle();
        await supabase
          .from('freelancer_profiles')
          .update({ wallet_balance: Number(current?.wallet_balance || 0) + amt })
          .eq('id', senderId);
      } catch (refundErr) {
        console.error(
          `[Transfer] CRITICAL: refund failed for ${senderId}, amount ${amt}:`,
          refundErr.message
        );
      }
    }
    throw err;
  }

  return {
    sender: { id: sender.id, name: sender.name, phone: sender.phone, email: sender.email },
    transfer: transferRecord,
  };
}

async function getTransferHistory(senderId, limit = 50) {
  const { data, error } = await supabase
    .from('transfers')
    .select('*')
    .eq('sender_id', senderId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function createWalletTopup(userId, amount) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('A valid positive amount is required');
  }
  if (amt > MAX_TRANSFER_AMOUNT) {
    throw new Error('Amount exceeds the maximum limit of ₦10,000,000.');
  }

  const { data: profile } = await supabase
    .from('freelancer_profiles')
    .select('email, name')
    .eq('id', userId)
    .maybeSingle();

  const email = (profile?.email && String(profile.email).includes('@'))
    ? profile.email
    : 'payments@payoapp.org';

  const { authorizationUrl, reference } = await initializeWalletTopup({
    email,
    amount: amt,
    userId,
  });

  return { paymentUrl: authorizationUrl, reference };
}

module.exports = {
  resolveRecipient,
  initiateTransfer,
  createTransferRecipient,
  getTransferHistory,
  createWalletTopup,
};

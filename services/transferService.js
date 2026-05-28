const axios = require('axios');
const supabase = require('../supabase');
const { normalizeNigerianPhone } = require('../whatsapp');
const { sendPaymentConfirmedWhatsApp } = require('../whatsapp');

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

async function initiateTransfer(senderId, recipientDetails, amount, reason, options = {}) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');

  const senderLock = await supabase
    .from('freelancer_profiles')
    .select('id, wallet_balance, name, phone, email')
    .eq('id', senderId)
    .single();

  if (senderLock.error) throw senderLock.error;
  const sender = senderLock.data;
  if (!sender) {
    throw new Error('Sender profile not found');
  }

  const senderBalance = Number(sender.wallet_balance || 0);
  if (!Number.isFinite(senderBalance) || senderBalance < amt) {
    throw new Error('Insufficient wallet balance');
  }

  const newSenderBalance = senderBalance - amt;

  // Debit sender
  const { error: debitError } = await supabase
    .from('freelancer_profiles')
    .update({ wallet_balance: newSenderBalance })
    .eq('id', senderId);
  if (debitError) throw debitError;

  let transferRecord = null;
  let status = 'success';
  let provider = 'internal';
  let providerReference = null;

  try {
    if (recipientDetails.type === 'payo') {
      const recipient = recipientDetails.profile;
      const recipientBalance = Number(recipient.wallet_balance || 0);
      const { error: creditError } = await supabase
        .from('freelancer_profiles')
        .update({ wallet_balance: recipientBalance + amt })
        .eq('id', recipient.id);
      if (creditError) throw creditError;

      provider = 'payo';
      providerReference = `payo_${Date.now()}`;

      const toPhone = recipient.phone || recipientDetails.phoneOrEmail;
      if (toPhone) {
        await sendPaymentConfirmedWhatsApp(
          toPhone,
          sender.name || sender.email || 'Someone',
          amt,
          'NGN'
        );
      }

      const { data, error } = await supabase
        .from('transfers')
        .insert({
          sender_id: senderId,
          recipient_type: 'payo',
          recipient_id: recipient.id,
          recipient_phone_or_email: recipient.email || recipient.phone || null,
          amount: amt,
          reason: reason || null,
          status,
          provider,
          provider_reference: providerReference,
        })
        .select()
        .single();
      if (error) throw error;
      transferRecord = data;
    } else {
      provider = 'paystack';
      const { accountNumber, bankCode, name } = options;
      if (!accountNumber || !bankCode) {
        throw new Error('Bank details required for external transfer');
      }

      // Verify account exists before creating recipient
      try {
        const ps = paystackClient();
        await ps.get('/bank/resolve', {
          params: { account_number: accountNumber, bank_code: bankCode },
        });
      } catch (err) {
        throw new Error(
          `Paystack bank resolution failed: ${err.response?.data?.message || err.message}`
        );
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

      // Notify if we have a phone
      if (recipientDetails.phoneOrEmail) {
        await sendPaymentConfirmedWhatsApp(
          recipientDetails.phoneOrEmail,
          sender.name || sender.email || 'Someone',
          amt,
          'NGN'
        );
      }

      const { data, error } = await supabase
        .from('transfers')
        .insert({
          sender_id: senderId,
          recipient_type: 'external',
          recipient_phone_or_email: recipientDetails.phoneOrEmail,
          amount: amt,
          reason: reason || null,
          status,
          provider,
          provider_reference: providerReference,
        })
        .select()
        .single();
      if (error) throw error;
      transferRecord = data;
    }
  } catch (err) {
    // Roll back debit best-effort
    await supabase
      .from('freelancer_profiles')
      .update({ wallet_balance: senderBalance })
      .eq('id', senderId);
    throw err;
  }

  return {
    sender: { id: sender.id, wallet_balance: newSenderBalance },
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

module.exports = {
  resolveRecipient,
  initiateTransfer,
  createTransferRecipient,
  getTransferHistory,
};


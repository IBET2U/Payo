const PAYSTACK_API = 'https://api.paystack.co';

function toSmallestUnit(amount, currency) {
  const code = (currency || 'NGN').toUpperCase();
  const value = Number(amount);

  if (Number.isNaN(value) || value <= 0) {
    throw new Error('Amount must be a positive number');
  }

  if (code === 'NGN') {
    return Math.round(value * 100);
  }
  if (code === 'USD') {
    return Math.round(value * 100);
  }

  throw new Error(`Unsupported currency: ${code}. Use NGN or USD.`);
}

async function initializePayment({
  clientEmail,
  amount,
  invoiceId,
  clientName,
  currency = 'NGN',
  subaccount,
  bearer,
  transaction_charge,
}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured');
  }

  const normalizedCurrency = currency.toUpperCase();
  const reference = `payo_${invoiceId}_${Date.now()}`;

  const payload = {
    email: clientEmail,
    amount: toSmallestUnit(amount, normalizedCurrency),
    currency: normalizedCurrency,
    reference,
    metadata: {
      invoice_id: String(invoiceId),
      client_name: clientName,
    },
  };

  if (process.env.PAYSTACK_CALLBACK_URL) {
    payload.callback_url = process.env.PAYSTACK_CALLBACK_URL;
  }

  if (subaccount) {
    payload.subaccount = subaccount;
    payload.bearer = bearer || 'subaccount';
    if (transaction_charge !== undefined && transaction_charge !== null) {
      payload.transaction_charge = transaction_charge;
    }
  }

  const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok || !result.status) {
    throw new Error(result.message || 'Failed to initialize Paystack payment');
  }

  return {
    authorizationUrl: result.data.authorization_url,
    accessCode: result.data.access_code,
    reference: result.data.reference,
  };
}

async function initializeWalletTopup({ email, amount, userId }) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not configured');

  const reference = `wallet_topup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    email,
    amount: Math.round(Number(amount) * 100),
    currency: 'NGN',
    reference,
    metadata: {
      topup_user_id: String(userId),
      topup_amount: String(amount),
    },
  };

  if (process.env.PAYSTACK_CALLBACK_URL) {
    payload.callback_url = process.env.PAYSTACK_CALLBACK_URL;
  }

  const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok || !result.status) {
    throw new Error(result.message || 'Failed to initialize wallet top-up');
  }

  return {
    authorizationUrl: result.data.authorization_url,
    reference: result.data.reference,
  };
}

// Collect payment from sender and carry the full transfer intent in metadata
// so the webhook can execute the transfer automatically on confirmation.
async function initializeSendPayment({
  email, amount, senderId,
  recipientType, recipientId, recipientPhone,
  accountNumber, bankCode, recipientName, reason,
}) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not configured');

  const reference = `paysend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    email,
    amount: Math.round(Number(amount) * 100),
    currency: 'NGN',
    reference,
    metadata: {
      pending_send_user_id:      String(senderId       || ''),
      pending_send_amount:       String(amount         || ''),
      pending_send_recipient_type: String(recipientType || ''),
      pending_send_recipient_id: String(recipientId    || ''),
      pending_send_recipient_phone: String(recipientPhone || ''),
      pending_send_account_number: String(accountNumber || ''),
      pending_send_bank_code:    String(bankCode       || ''),
      pending_send_name:         String(recipientName  || ''),
      pending_send_reason:       String(reason         || ''),
    },
  };

  if (process.env.PAYSTACK_CALLBACK_URL) {
    payload.callback_url = process.env.PAYSTACK_CALLBACK_URL;
  }

  const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok || !result.status) {
    throw new Error(result.message || 'Failed to initialize send payment');
  }

  return { authorizationUrl: result.data.authorization_url, reference: result.data.reference };
}

module.exports = { initializePayment, initializeWalletTopup, initializeSendPayment, toSmallestUnit };

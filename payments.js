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

module.exports = { initializePayment, toSmallestUnit };

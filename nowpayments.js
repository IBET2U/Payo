const axios = require('axios');

const NOWPAYMENTS_API = 'https://api.nowpayments.io/v1';

async function createPaymentInvoice({
  clientEmail,
  amount,
  invoiceId,
  description,
  freelancerWalletAddress,
}) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error('NOWPAYMENTS_API_KEY is not configured');
  }

  const payload = {
    price_amount: Number(amount),
    price_currency: 'usd',
    pay_currency: 'usdc',
    order_id: String(invoiceId),
    order_description: description || `Payo invoice ${invoiceId}`,
  };

  if (process.env.NOWPAYMENTS_IPN_CALLBACK_URL) {
    payload.ipn_callback_url = process.env.NOWPAYMENTS_IPN_CALLBACK_URL;
  }
  if (process.env.NOWPAYMENTS_SUCCESS_URL) {
    payload.success_url = process.env.NOWPAYMENTS_SUCCESS_URL;
  }
  if (process.env.NOWPAYMENTS_CANCEL_URL) {
    payload.cancel_url = process.env.NOWPAYMENTS_CANCEL_URL;
  }

  if (freelancerWalletAddress) {
    payload.payout_address = freelancerWalletAddress;
    payload.payout_currency = 'usdc';
  }

  try {
    const { data } = await axios.post(`${NOWPAYMENTS_API}/invoice`, payload, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!data?.invoice_url) {
      throw new Error('NOWPayments did not return an invoice URL');
    }

    return {
      paymentUrl: data.invoice_url,
      reference: String(data.id ?? data.order_id ?? invoiceId),
      provider: 'nowpayments',
      clientEmail,
    };
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    throw new Error(`NOWPayments error: ${message}`);
  }
}

module.exports = { createPaymentInvoice };

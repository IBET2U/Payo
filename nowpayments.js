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

  const wallet = freelancerWalletAddress
    ? String(freelancerWalletAddress).trim()
    : '';
  const baseDescription = description || `Payo invoice ${invoiceId}`;

  const payload = {
    price_amount: Number(amount),
    price_currency: 'usd',
    pay_currency: 'usdc',
    order_id: String(invoiceId),
    order_description: wallet ? `${baseDescription} (wallet: ${wallet})` : baseDescription,
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

  async function postInvoice(body) {
    const { data } = await axios.post(`${NOWPAYMENTS_API}/invoice`, body, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });
    return data;
  }

  try {
    let data;
    const withPayout =
      wallet && process.env.NOWPAYMENTS_USE_PAYOUT_ADDRESS === 'true';

    if (withPayout) {
      try {
        data = await postInvoice({
          ...payload,
          payout_address: wallet,
          payout_currency: 'usdc',
        });
      } catch (err) {
        const message = err.response?.data?.message || err.message || '';
        if (!/payout_address/i.test(message)) {
          throw err;
        }
        console.warn('[NOWPayments] payout_address rejected, creating invoice without it');
        data = await postInvoice(payload);
      }
    } else {
      data = await postInvoice(payload);
    }

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

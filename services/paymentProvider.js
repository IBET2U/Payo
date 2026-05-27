const { initializePayment } = require('../payments');
const { createPaymentInvoice } = require('../nowpayments');

async function createPaymentLink({
  currency,
  clientEmail,
  amount,
  invoiceId,
  clientName,
  description,
  freelancerWalletAddress,
}) {
  const code = String(currency || 'NGN').toUpperCase().trim() === 'USD' ? 'USD' : 'NGN';

  console.log(`[paymentProvider] ${code} payment link for invoice ${invoiceId}`);

  if (code === 'USD') {
    return createPaymentInvoice({
      clientEmail,
      amount,
      invoiceId,
      description,
      freelancerWalletAddress,
    });
  }

  const { authorizationUrl, reference } = await initializePayment({
    clientEmail,
    amount,
    invoiceId,
    clientName,
    currency: 'NGN',
  });

  return {
    paymentUrl: authorizationUrl,
    reference,
    provider: 'paystack',
  };
}

module.exports = { createPaymentLink };

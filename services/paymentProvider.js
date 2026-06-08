const { initializePayment } = require('../payments');
const { createPaymentInvoice } = require('../nowpayments');
const { getProfile } = require('./profileService');

const PAYO_PAYSTACK_FALLBACK_EMAIL = 'payments@payoapp.org';

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

  const safeEmail =
    clientEmail && String(clientEmail).includes('@')
      ? clientEmail
      : PAYO_PAYSTACK_FALLBACK_EMAIL;

  let subaccountCode = null;
  if (freelancerId) {
    try {
      const profile = await getProfile(freelancerId);
      const code = profile?.subaccount_code && String(profile.subaccount_code).trim();
      if (code) {
        subaccountCode = code;
        console.log(`[paymentProvider] Using subaccount ${code} for invoice ${invoiceId}`);
      }
    } catch (err) {
      console.warn(
        `[paymentProvider] Could not load subaccount for ${freelancerId}:`,
        err.message
      );
    }
  }

  const { authorizationUrl, reference } = await initializePayment({
    clientEmail: safeEmail,
    amount,
    invoiceId,
    clientName,
    currency: 'NGN',
    subaccount: subaccountCode || undefined,
    bearer: subaccountCode ? 'subaccount' : undefined,
  });

  return {
    paymentUrl: authorizationUrl,
    reference,
    provider: 'paystack',
  };
}

module.exports = { createPaymentLink, PAYO_PAYSTACK_FALLBACK_EMAIL };

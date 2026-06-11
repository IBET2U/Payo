const { initializePayment } = require('../payments');
const { createPaymentInvoice } = require('../nowpayments');
const supabase = require('../supabase');

const PAYO_PAYSTACK_FALLBACK_EMAIL = 'payments@payoapp.org';

async function createPaymentLink({
  currency,
  clientEmail,
  amount,
  invoiceId,
  clientName,
  description,
  freelancerWalletAddress,
  freelancerId,
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
    // If this lookup fails we must NOT fall back to the main Paystack account —
    // that would silently route the freelancer's money to Payo.
    const { data: profile, error: profileError } = await supabase
      .from('freelancer_profiles')
      .select('subaccount_code')
      .eq('id', freelancerId)
      .maybeSingle();

    if (profileError) {
      throw new Error(
        `Could not load payment routing for this seller: ${profileError.message}`
      );
    }

    const code = profile?.subaccount_code && String(profile.subaccount_code).trim();
    if (code) {
      subaccountCode = code;
      console.log(`[paymentProvider] Using subaccount ${code} for invoice ${invoiceId}`);
    }
  }

  const paystackOptions = {
    clientEmail: safeEmail,
    amount,
    invoiceId,
    clientName,
    currency: 'NGN',
  };

  if (subaccountCode) {
    paystackOptions.subaccount = subaccountCode;
    paystackOptions.bearer = 'subaccount';
    paystackOptions.transaction_charge = 0;
  }

  const { authorizationUrl, reference } = await initializePayment(paystackOptions);

  return {
    paymentUrl: authorizationUrl,
    reference,
    provider: 'paystack',
  };
}

module.exports = { createPaymentLink, PAYO_PAYSTACK_FALLBACK_EMAIL };

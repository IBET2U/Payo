const { generateInvoice } = require('../claude');
const { sendInvoiceEmail } = require('../mailer');
const { createPaymentLink } = require('./paymentProvider');
const { getProfile } = require('./profileService');
const { normalizeCurrency, enforceCurrencyInInvoiceBody } = require('../lib/currency');
const { sendInvoiceWhatsApp, normalizeNigerianPhone } = require('../whatsapp');
const supabase = require('../supabase');

function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

async function createAndSendInvoice({
  freelancer_id,
  freelancer_email,
  freelancer_name,
  client_name,
  client_email,
  client_phone,
  project_description,
  amount,
  due_date,
  currency = 'NGN',
}) {
  console.log('[INVOICE DEBUG] Received currency:', currency, 'normalized:', currency?.toUpperCase());
  const normalizedCurrency = normalizeCurrency(currency);

  if (normalizedCurrency !== 'NGN' && normalizedCurrency !== 'USD') {
    throw new Error(`Invalid currency: ${currency}`);
  }

  // Payment routing guard: never create an invoice whose money has nowhere to land.
  const profile = await getProfile(freelancer_id);

  if (normalizedCurrency === 'NGN') {
    const subaccountCode = trimOrNull(profile?.subaccount_code);
    if (!subaccountCode) {
      return {
        success: false,
        error: 'bank_account_required',
        message:
          'Please add your Nigerian bank account before creating Naira invoices. This ensures payments go directly to your account.',
      };
    }
  }

  if (normalizedCurrency === 'USD') {
    const walletAddress = trimOrNull(profile?.wallet_address);
    if (!walletAddress) {
      return {
        success: false,
        error: 'wallet_required',
        message: 'Please add your USDC wallet address before creating USD invoices.',
      };
    }
  }

  // Transaction limits
  const transactionAmount = Number(amount);
  if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) {
    throw new Error('A valid amount greater than zero is required');
  }

  const accountCreatedAt = profile?.created_at
    ? new Date(profile.created_at).getTime()
    : 0;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const isNewAccount = accountCreatedAt > 0 && Date.now() - accountCreatedAt < thirtyDays;

  if (isNewAccount && transactionAmount > 500000 && normalizedCurrency === 'NGN') {
    throw new Error(
      'New account limit is ₦500,000 per transaction. Contact support@payoapp.org to increase your limit.'
    );
  }
  if (transactionAmount > 10000000) {
    throw new Error(
      'Transaction amount exceeds maximum limit of ₦10,000,000. Contact support@payoapp.org.'
    );
  }

  const cleanClientEmail = trimOrNull(client_email);
  const rawClientPhone = trimOrNull(client_phone);
  const normalizedClientPhone = rawClientPhone ? normalizeNigerianPhone(rawClientPhone) : null;
  const isQuickPayment = String(client_name || '').trim() === 'Quick Payment';

  if (!isQuickPayment && !cleanClientEmail && !normalizedClientPhone) {
    throw new Error('At least one of client_email or client_phone is required');
  }

  let invoice_content;
  if (isQuickPayment) {
    const desc = trimOrNull(project_description) || 'Quick Payment';
    invoice_content = `Payo Quick Payment Link\n\n${desc}\nAmount due: ${amount}\nDue: ${due_date}`;
  } else {
    console.log('[INVOICE DEBUG] Calling generateInvoice with currency:', normalizedCurrency);
    invoice_content = await generateInvoice(
      project_description,
      client_name,
      amount,
      due_date,
      normalizedCurrency
    );
    invoice_content = enforceCurrencyInInvoiceBody(
      invoice_content,
      normalizedCurrency,
      amount
    );
  }

  const freelancerProfilePhone = profile?.phone
    ? normalizeNigerianPhone(profile.phone) || trimOrNull(profile.phone)
    : null;
  const freelancerWalletAddress =
    normalizedCurrency === 'USD' ? trimOrNull(profile?.wallet_address) || undefined : undefined;

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      freelancer_id,
      freelancer_email,
      freelancer_phone: freelancerProfilePhone,
      client_name,
      client_email: cleanClientEmail,
      client_phone: normalizedClientPhone,
      project_description,
      amount,
      due_date,
      currency: normalizedCurrency,
      invoice_content,
      status: 'unpaid',
      source: 'web',
    })
    .select()
    .single();

  if (error) throw error;

  let paymentUrl = null;
  let reference = null;
  try {
    const paymentResult = await createPaymentLink({
      currency: normalizedCurrency,
      clientEmail: cleanClientEmail,
      amount,
      invoiceId: data.id,
      clientName: client_name,
      description: project_description,
      freelancerWalletAddress,
      freelancerId: freelancer_id,
    });
    paymentUrl = paymentResult.paymentUrl;
    reference = paymentResult.reference;
  } catch (paymentErr) {
    console.error('[invoiceService] Payment link failed:', paymentErr.message);
    // Continue without payment link — email still sends
  }

  const { data: invoice, error: updateError } = await supabase
    .from('invoices')
    .update({
      payment_url: paymentUrl || null,
      payment_reference: reference || null,
    })
    .eq('id', data.id)
    .select()
    .single();

  if (updateError) throw updateError;

  if (cleanClientEmail && !isQuickPayment) {
    try {
      await sendInvoiceEmail(
        {
          id: invoice.id,
          client_email: cleanClientEmail,
          client_name,
          client_phone: normalizedClientPhone,
          project_description,
          amount,
          due_date,
          payment_url: paymentUrl,
          currency: normalizedCurrency,
          created_at: invoice.created_at,
          freelancer_email,
          freelancer_name: freelancer_name || profile?.name || 'Your Freelancer',
        },
        profile
      );
    } catch (err) {
      console.error(
        `[invoiceService] sendInvoiceEmail failed for invoice ${invoice.id}:`,
        err.message
      );
    }
  } else {
    console.log(
      `[invoiceService] No client_email for invoice ${invoice.id}, skipping email send`
    );
  }

  if (normalizedClientPhone) {
    try {
      await sendInvoiceWhatsApp(
        normalizedClientPhone,
        client_name,
        freelancer_name || 'Your Freelancer',
        amount,
        normalizedCurrency,
        due_date,
        paymentUrl
      );
    } catch (err) {
      console.error(
        `[invoiceService] sendInvoiceWhatsApp failed for invoice ${invoice.id}:`,
        err.message
      );
    }
  }

  return { success: true, invoice, payment_url: paymentUrl };
}

module.exports = { createAndSendInvoice };

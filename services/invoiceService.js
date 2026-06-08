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

  let freelancerProfilePhone = null;
  let freelancerWalletAddress;
  try {
    const profile = await getProfile(freelancer_id);
    freelancerProfilePhone = profile?.phone
      ? normalizeNigerianPhone(profile.phone) || trimOrNull(profile.phone)
      : null;
    if (normalizedCurrency === 'USD' && profile?.wallet_address) {
      const wallet = String(profile.wallet_address).trim();
      freelancerWalletAddress = wallet || undefined;
    }
  } catch (err) {
    console.error(
      `[invoiceService] getProfile failed for ${freelancer_id}, continuing without wallet:`,
      err.message
    );
    freelancerWalletAddress = undefined;
  }

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
        cleanClientEmail,
        client_name,
        freelancer_name || 'Your Freelancer',
        invoice_content,
        amount,
        due_date,
        invoice.id,
        paymentUrl,
        normalizedCurrency
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

  return { invoice, payment_url: paymentUrl };
}

module.exports = { createAndSendInvoice };

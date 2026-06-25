const { Resend } = require('resend');
const {
  normalizeCurrency,
  formatAmountForCurrency,
  enforceCurrencyInInvoiceBody,
} = require('./lib/currency');

const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInvoiceDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(d.getTime())) return String(dateStr || '');
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildInvoiceEmailHtml(invoiceData, freelancerProfile) {
  const invoice = invoiceData || {};
  const profile = freelancerProfile || {};

  const normalizedCurrency = normalizeCurrency(invoice.currency || 'NGN');
  const currencySymbol = normalizedCurrency === 'USD' ? '$' : '₦';
  const { formattedAmount } = formatAmountForCurrency(invoice.amount, normalizedCurrency);

  const invoiceColor = profile.invoice_color && /^#[0-9A-Fa-f]{6}$/.test(profile.invoice_color)
    ? profile.invoice_color
    : '#00a884';

  const logoUrl = profile.logo_url ? String(profile.logo_url).trim() : '';
  const businessName = escapeHtml(
    profile.business_name || profile.name || invoice.freelancer_name || 'Your Freelancer'
  );
  const businessAddress = profile.business_address ? escapeHtml(profile.business_address) : '';
  const businessPhone = profile.business_phone ? escapeHtml(profile.business_phone) : '';
  const businessWebsite = profile.business_website ? escapeHtml(profile.business_website) : '';
  const freelancerEmail = escapeHtml(profile.email || invoice.freelancer_email || '');
  const clientName = escapeHtml(invoice.client_name || 'Client');
  const clientEmail = invoice.client_email ? escapeHtml(invoice.client_email) : '';
  const clientPhone = invoice.client_phone ? escapeHtml(invoice.client_phone) : '';
  const projectDescription = escapeHtml(invoice.project_description || 'Services rendered');
  const invoiceNote = profile.invoice_note ? escapeHtml(profile.invoice_note) : '';
  const paymentUrl = invoice.payment_url ? escapeHtml(invoice.payment_url) : '';

  const invoiceId = String(invoice.id || '');
  const invoiceNumber = invoiceId
    ? `INV-${invoiceId.substring(0, 8).toUpperCase()}`
    : 'INV-DRAFT';
  const invoiceDate = formatInvoiceDate(invoice.created_at || new Date().toISOString());
  const dueDate = formatInvoiceDate(invoice.due_date);

  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="Logo" style="max-height:60px;max-width:180px;object-fit:contain;display:block;">`
    : '';

  const payButtonBlock = paymentUrl
    ? `<a href="${paymentUrl}" style="display:block;background:${invoiceColor};color:#ffffff;text-decoration:none;text-align:center;padding:16px 32px;font-size:16px;font-weight:700;margin:32px 0;border-radius:4px;">Pay Now →</a>`
    : '';

  const noteBlock = invoiceNote
    ? `<div style="background:#f9f9f9;border-left:3px solid ${invoiceColor};padding:16px 20px;margin-top:24px;font-size:13px;color:#555;line-height:1.5;">${invoiceNote.replace(/\n/g, '<br>')}</div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${invoiceNumber}</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f5f5f5;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;">

  <div style="background:${invoiceColor};padding:32px 40px;">
    ${logoBlock}
    <div style="color:#ffffff;font-size:28px;font-weight:700;margin-top:${logoUrl ? '16px' : '0'};">INVOICE</div>
    <div style="color:rgba(255,255,255,0.7);font-size:14px;margin-top:4px;">#${invoiceNumber} &nbsp;·&nbsp; ${invoiceDate}</div>
  </div>

  <div style="padding:40px;">

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td valign="top" width="50%">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:8px;">From</div>
          <div style="font-size:16px;font-weight:700;color:#111;margin-bottom:4px;">${businessName}</div>
          ${businessAddress ? `<div style="font-size:13px;color:#666;margin-bottom:2px;">${businessAddress}</div>` : ''}
          ${businessPhone ? `<div style="font-size:13px;color:#666;margin-bottom:2px;">${businessPhone}</div>` : ''}
          ${businessWebsite ? `<div style="font-size:13px;color:#666;margin-bottom:2px;">${businessWebsite}</div>` : ''}
          ${freelancerEmail ? `<div style="font-size:13px;color:#666;margin-bottom:2px;">${freelancerEmail}</div>` : ''}
        </td>
        <td valign="top" width="50%" align="right">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:8px;">Bill To</div>
          <div style="font-size:16px;font-weight:700;color:#111;margin-bottom:4px;">${clientName}</div>
          ${clientEmail ? `<div style="font-size:13px;color:#666;margin-bottom:2px;">${clientEmail}</div>` : ''}
          ${clientPhone ? `<div style="font-size:13px;color:#666;margin-bottom:2px;">${clientPhone}</div>` : ''}
        </td>
      </tr>
    </table>

    <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td style="padding-right:40px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:4px;">Invoice Date</div>
          <div style="font-size:15px;font-weight:600;color:#111;">${invoiceDate}</div>
        </td>
        <td>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#999;margin-bottom:4px;">Due Date</div>
          <div style="font-size:15px;font-weight:600;color:#111;">${dueDate}</div>
        </td>
      </tr>
    </table>

    <div style="height:1px;background:#eee;margin:24px 0;"></div>

    <table width="100%" cellpadding="0" cellspacing="0" style="padding:16px 0;border-bottom:1px solid #f0f0f0;">
      <tr>
        <td style="font-size:14px;color:#333;font-weight:500;">${projectDescription}</td>
        <td align="right" style="font-size:14px;color:#111;font-weight:700;">${currencySymbol}${formattedAmount}</td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 0;margin-top:8px;">
      <tr>
        <td style="font-size:16px;font-weight:700;color:#111;">Total Due</td>
        <td align="right" style="font-size:24px;font-weight:900;color:${invoiceColor};">${currencySymbol}${formattedAmount}</td>
      </tr>
    </table>

    ${payButtonBlock}
    ${noteBlock}

  </div>

  <div style="background:#f9f9f9;padding:24px 40px;text-align:center;font-size:12px;color:#999;border-top:1px solid #eee;line-height:1.6;">
    <span style="color:#00a884;font-weight:600;">Powered by Payo 💚</span> —
    AI payment agent for African professionals<br>
    <a href="https://payoapp.org" style="color:#00a884;">payoapp.org</a>
  </div>

</div>
</body>
</html>`;
}

async function sendInvoiceEmail(invoiceData, freelancerProfile) {
  const invoice = invoiceData || {};
  const normalizedCurrency = normalizeCurrency(invoice.currency || 'NGN');
  const { display } = formatAmountForCurrency(invoice.amount, normalizedCurrency);
  const dueDateLabel = formatInvoiceDate(invoice.due_date);

  const html = buildInvoiceEmailHtml(invoice, freelancerProfile);

  const { data, error } = await resend.emails.send({
    from: 'Payo <invoices@payoapp.org>',
    to: invoice.client_email,
    subject: `Invoice for ${display} — Due ${dueDateLabel}`,
    html,
  });

  if (error) throw error;
  return data;
}

async function sendFollowUpEmail(
  clientEmail,
  clientName,
  followUpContent,
  amount,
  dueDate,
  currency = 'NGN'
) {
  const normalizedCurrency = normalizeCurrency(currency);
  const { display } = formatAmountForCurrency(amount, normalizedCurrency);
  const body = enforceCurrencyInInvoiceBody(followUpContent, normalizedCurrency, amount);

  const { data, error } = await resend.emails.send({
    from: 'Payo <invoices@payoapp.org>',
    to: clientEmail,
    subject: `Following up on your invoice — ${display} due ${dueDate}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        
        <div style="background: #000; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #00f5c4; margin: 0; font-size: 28px;">Payo</h1>
          <p style="color: #fff; margin: 5px 0 0; font-size: 12px;">Payment Reminder</p>
        </div>

        <div style="background: #f9f9f9; padding: 30px; border: 1px solid #eee;">
          <p style="color: #333; font-size: 15px; line-height: 1.6;">${body.replace(/\n/g, '<br>').replace(/\*\*/g, '').replace(/---/g, '<hr>')}</p>
        </div>

        <div style="background: #000; padding: 15px; border-radius: 0 0 8px 8px; text-align: center;">
          <p style="color: #666; font-size: 11px; margin: 0;">Powered by Payo — The Financial Agent for African Professionals</p>
          <p style="color: #666; font-size: 11px; margin: 5px 0 0;">payoapp.org</p>
        </div>

      </div>
    `,
  });

  if (error) throw error;
  return data;
}

async function sendPaymentConfirmationEmail(
  freelancerEmail,
  clientName,
  amount,
  paidAt,
  currency = 'NGN'
) {
  const normalizedCurrency = normalizeCurrency(currency);
  const { display } = formatAmountForCurrency(amount, normalizedCurrency);

  const datePaid = new Date(paidAt).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const { data, error } = await resend.emails.send({
    from: 'Payo <invoices@payoapp.org>',
    to: freelancerEmail,
    subject: 'You just got paid! 🎉',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">

        <div style="background: #000; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #00f5c4; margin: 0; font-size: 28px;">Payo</h1>
          <p style="color: #fff; margin: 5px 0 0; font-size: 12px;">Payment Received</p>
        </div>

        <div style="background: #f9f9f9; padding: 30px; border: 1px solid #eee;">
          <p style="color: #333; font-size: 20px; font-weight: bold; margin: 0 0 12px;">You just got paid! 🎉</p>
          <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            Congratulations — the money is in! ${clientName} just settled your invoice, and Payo has confirmed the payment. Well deserved.
          </p>
          <div style="background: #fff; padding: 20px; border-left: 4px solid #00f5c4;">
            <p style="color: #333; font-size: 14px; margin: 0 0 10px;"><strong>Amount received:</strong> ${display}</p>
            <p style="color: #333; font-size: 14px; margin: 0 0 10px;"><strong>Client:</strong> ${clientName}</p>
            <p style="color: #333; font-size: 14px; margin: 0;"><strong>Date paid:</strong> ${datePaid}</p>
          </div>
          <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 24px 0 0;">
            Keep doing great work — Payo has your back.
          </p>
        </div>

        <div style="background: #000; padding: 15px; border-radius: 0 0 8px 8px; text-align: center;">
          <p style="color: #666; font-size: 11px; margin: 0;">Powered by Payo — The Financial Agent for African Professionals</p>
          <p style="color: #666; font-size: 11px; margin: 5px 0 0;">payoapp.org</p>
        </div>

      </div>
    `,
  });

  if (error) throw error;
  return data;
}

async function sendCheckoutDownloadEmail(customerEmail, productName, downloadUrl) {
  const { data, error } = await resend.emails.send({
    from: 'Payo <invoices@payoapp.org>',
    to: customerEmail,
    subject: `Your download is ready — ${productName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #000; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #00f5c4; margin: 0; font-size: 28px;">Payo</h1>
          <p style="color: #fff; margin: 5px 0 0; font-size: 12px;">Digital Download</p>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border: 1px solid #eee;">
          <p style="color: #333; font-size: 15px; line-height: 1.6;">
            Thank you for your purchase! Download here:
          </p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${downloadUrl}" style="display: inline-block; background: #00a884; color: #fff; font-weight: bold; font-size: 16px; padding: 14px 32px; border-radius: 6px; text-decoration: none;">Download Now</a>
          </div>
          <p style="color: #666; font-size: 13px; line-height: 1.5;">
            Or copy this link: ${downloadUrl}<br>
            This link expires in 48 hours and allows 3 downloads.
          </p>
        </div>
        <div style="background: #000; padding: 15px; border-radius: 0 0 8px 8px; text-align: center;">
          <p style="color: #666; font-size: 11px; margin: 0;">Powered by Payo — payoapp.org</p>
        </div>
      </div>
    `,
  });

  if (error) throw error;
  return data;
}

module.exports = {
  sendInvoiceEmail,
  buildInvoiceEmailHtml,
  sendFollowUpEmail,
  sendPaymentConfirmationEmail,
  sendCheckoutDownloadEmail,
  formatAmountForCurrency,
};

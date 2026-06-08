const { Resend } = require('resend');
const {
  normalizeCurrency,
  formatAmountForCurrency,
  enforceCurrencyInInvoiceBody,
} = require('./lib/currency');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendInvoiceEmail(
  clientEmail,
  clientName,
  freelancerName,
  invoiceContent,
  amount,
  dueDate,
  invoiceId,
  paymentUrl,
  currency = 'NGN'
) {
  const normalizedCurrency = normalizeCurrency(currency);
  const { display } = formatAmountForCurrency(amount, normalizedCurrency);
  const body = enforceCurrencyInInvoiceBody(invoiceContent, normalizedCurrency, amount);

  const payNowButton = paymentUrl
    ? `
          <div style="text-align: center; margin-top: 25px;">
            <a href="${paymentUrl}" style="display: inline-block; background: #00f5c4; color: #000; font-weight: bold; font-size: 16px; padding: 14px 32px; border-radius: 6px; text-decoration: none;">Pay Now</a>
          </div>`
    : '';

  const { data, error } = await resend.emails.send({
    from: 'Payo <invoices@payoapp.org>',
    to: clientEmail,
    subject: `Invoice for ${display} — Due ${dueDate}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        
        <div style="background: #000; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #00f5c4; margin: 0; font-size: 28px;">Payo</h1>
          <p style="color: #fff; margin: 5px 0 0; font-size: 12px;">Professional Invoice</p>
        </div>

        <div style="background: #f9f9f9; padding: 30px; border: 1px solid #eee;">
          <p style="color: #333; font-size: 15px; line-height: 1.6;">${body.replace(/\n/g, '<br>').replace(/\*\*/g, '').replace(/---/g, '<hr>')}</p>
          ${payNowButton}
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

module.exports = {
  sendInvoiceEmail,
  sendFollowUpEmail,
  sendPaymentConfirmationEmail,
  formatAmountForCurrency,
};

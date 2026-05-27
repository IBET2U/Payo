const express = require('express');
const crypto = require('crypto');
const supabase = require('../supabase');
const { sendPaymentConfirmationEmail } = require('../mailer');
const { sendPaymentConfirmedWhatsApp } = require('../whatsapp');

const router = express.Router();

function verifyPaystackSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function extractInvoiceId(metadata) {
  if (!metadata) return null;

  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed.invoice_id || null;
    } catch {
      return null;
    }
  }

  return metadata.invoice_id || null;
}

async function resolveFreelancerEmail(invoice, freelancerId) {
  if (invoice.freelancer_email && String(invoice.freelancer_email).trim()) {
    return invoice.freelancer_email.trim();
  }

  if (!freelancerId) return null;

  try {
    const { data: profile, error } = await supabase
      .from('freelancer_profiles')
      .select('email')
      .eq('id', freelancerId)
      .maybeSingle();

    if (error) {
      console.warn('[Paystack Webhook] Could not load profile email:', error.message);
      return null;
    }

    return profile?.email && String(profile.email).trim() ? profile.email.trim() : null;
  } catch (err) {
    console.warn('[Paystack Webhook] Profile email lookup failed:', err.message);
    return null;
  }
}

router.post('/', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (!verifyPaystackSignature(req.body, signature, secret)) {
    console.error('[Paystack Webhook] Invalid signature');
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid JSON payload' });
  }

  if (event.event !== 'charge.success') {
    return res.status(200).json({ success: true, message: 'Event ignored' });
  }

  const { data } = event;
  const invoiceId = extractInvoiceId(data?.metadata);

  if (!invoiceId) {
    console.error('[Paystack Webhook] charge.success missing invoice_id in metadata');
    return res.status(400).json({ success: false, error: 'invoice_id not found in metadata' });
  }

  try {
    const { data: invoice, error: fetchError } = await supabase
      .from('invoices')
      .select('id, freelancer_id, freelancer_email, freelancer_phone, client_name, amount, currency, status, payment_reference')
      .eq('id', invoiceId)
      .single();

    if (fetchError) throw fetchError;
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    if (invoice.status === 'paid') {
      console.log(`[Paystack Webhook] Invoice ${invoiceId} already paid`);
      return res.status(200).json({ success: true, message: 'Invoice already paid' });
    }

    if (
      invoice.payment_reference &&
      data.reference &&
      invoice.payment_reference !== data.reference
    ) {
      console.warn(
        `[Paystack Webhook] Reference mismatch for invoice ${invoiceId}: expected ${invoice.payment_reference}, got ${data.reference}`
      );
    }

    const paidAt = data.paid_at || data.paidAt || new Date().toISOString();

    const { data: updatedInvoice, error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: paidAt,
      })
      .eq('id', invoiceId)
      .select('id, freelancer_id, freelancer_email, freelancer_phone, client_name, amount, currency, status, paid_at')
      .single();

    if (updateError) throw updateError;

    console.log(`[Paystack Webhook] Invoice ${invoiceId} marked as paid`);

    const paidInvoice = updatedInvoice || invoice;
    const freelancerEmail = await resolveFreelancerEmail(
      paidInvoice,
      paidInvoice.freelancer_id || invoice.freelancer_id
    );

    if (freelancerEmail) {
      try {
        await sendPaymentConfirmationEmail(
          freelancerEmail,
          paidInvoice.client_name || invoice.client_name,
          paidInvoice.amount ?? invoice.amount,
          paidAt,
          paidInvoice.currency || invoice.currency || 'NGN'
        );
        console.log(
          `[Paystack Webhook] Payment confirmation sent to ${freelancerEmail}`
        );
      } catch (emailErr) {
        console.error(
          '[Paystack Webhook] Payment confirmation email failed:',
          emailErr.message
        );
      }
    } else {
      console.warn(
        `[Paystack Webhook] No freelancer_email for invoice ${invoiceId}, skipping confirmation email`
      );
    }

    const freelancerPhone = paidInvoice.freelancer_phone || invoice.freelancer_phone;
    if (freelancerPhone) {
      try {
        await sendPaymentConfirmedWhatsApp(
          freelancerPhone,
          paidInvoice.client_name || invoice.client_name,
          paidInvoice.amount ?? invoice.amount,
          paidInvoice.currency || invoice.currency || 'NGN'
        );
      } catch (waErr) {
        console.error(
          '[Paystack Webhook] Payment confirmation WhatsApp failed:',
          waErr.message
        );
      }
    }

    return res.status(200).json({ success: true, message: 'Payment processed' });
  } catch (err) {
    console.error('[Paystack Webhook] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

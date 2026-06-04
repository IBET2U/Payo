const express = require('express');
const crypto = require('crypto');
const supabase = require('../supabase');
const { sendPaymentConfirmationEmail } = require('../mailer');
const { sendPaymentConfirmedWhatsApp } = require('../whatsapp');
const { updateUserEarnings } = require('../services/earningsService');

const router = express.Router();

const PAID_STATUSES = new Set(['finished', 'confirmed']);

function sortObjectKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortObjectKeys(value[key]);
      return acc;
    }, {});
}

function verifyNowpaymentsSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) {
    return false;
  }

  try {
    const sorted = sortObjectKeys(payload);
    const serialized = JSON.stringify(sorted);
    const expected = crypto
      .createHmac('sha512', String(secret).trim())
      .update(serialized)
      .digest('hex');

    const received = String(signatureHeader).trim().toLowerCase();
    const expectedLower = expected.toLowerCase();

    if (received.length !== expectedLower.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(received, 'utf8'),
      Buffer.from(expectedLower, 'utf8')
    );
  } catch (err) {
    console.error('[NOWPayments Webhook] Signature verification error:', err.message);
    return false;
  }
}

function parseInvoiceId(orderId) {
  if (orderId === undefined || orderId === null) return null;
  const id = String(orderId).trim();
  return id || null;
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
      console.warn('[NOWPayments Webhook] Could not load profile email:', error.message);
      return null;
    }

    return profile?.email && String(profile.email).trim() ? profile.email.trim() : null;
  } catch (err) {
    console.warn('[NOWPayments Webhook] Profile email lookup failed:', err.message);
    return null;
  }
}

router.post('/', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;

    let payload;
    try {
      const raw = req.body;
      if (!raw || (Buffer.isBuffer(raw) && raw.length === 0)) {
        console.error('[NOWPayments Webhook] Empty body');
        return res.status(200).json({ success: true, message: 'Empty body ignored' });
      }
      payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch (parseErr) {
      console.error('[NOWPayments Webhook] Invalid JSON:', parseErr.message);
      return res.status(200).json({ success: true, message: 'Invalid JSON ignored' });
    }

    const sigValid = verifyNowpaymentsSignature(payload, signature, secret);
    if (!sigValid) {
      console.error('[NOWPayments Webhook] Invalid or missing signature', {
        hasSig: Boolean(signature),
        hasSecret: Boolean(secret),
      });
      return res.status(200).json({ success: true, message: 'Invalid signature, ignored' });
    }

    const paymentStatus = String(payload.payment_status || '').toLowerCase();
    if (!PAID_STATUSES.has(paymentStatus)) {
      console.log(`[NOWPayments Webhook] Ignoring payment_status: ${paymentStatus}`);
      return res.status(200).json({ success: true, message: 'Status ignored' });
    }

    const invoiceId = parseInvoiceId(payload.order_id);
    if (!invoiceId) {
      console.error('[NOWPayments Webhook] Missing order_id in payload');
      return res.status(200).json({ success: true, message: 'No order_id' });
    }

    const { data: invoice, error: fetchError } = await supabase
      .from('invoices')
      .select(
        'id, freelancer_id, freelancer_email, freelancer_phone, client_name, amount, currency, status, payment_reference'
      )
      .eq('id', invoiceId)
      .single();

    if (fetchError) {
      console.error(`[NOWPayments Webhook] Invoice fetch failed for ${invoiceId}:`, fetchError.message);
      return res.status(200).json({ success: true, message: 'Invoice not found' });
    }

    if (!invoice) {
      console.error(`[NOWPayments Webhook] Invoice not found: ${invoiceId}`);
      return res.status(200).json({ success: true, message: 'Invoice not found' });
    }

    if (invoice.status === 'paid') {
      console.log(`[NOWPayments Webhook] Invoice ${invoiceId} already paid`);
      return res.status(200).json({ success: true, message: 'Invoice already paid' });
    }

    const paidAt =
      payload.updated_at ||
      payload.created_at ||
      payload.payin_confirmations ||
      new Date().toISOString();

    const paymentReference =
      payload.payment_id != null
        ? String(payload.payment_id)
        : payload.invoice_id != null
          ? String(payload.invoice_id)
          : invoice.payment_reference;

    const updatePayload = {
      status: 'paid',
      paid_at: paidAt,
    };
    if (paymentReference) {
      updatePayload.payment_reference = paymentReference;
    }

    const { data: updatedInvoice, error: updateError } = await supabase
      .from('invoices')
      .update(updatePayload)
      .eq('id', invoiceId)
      .select(
        'id, freelancer_id, freelancer_email, freelancer_phone, client_name, amount, currency, status, paid_at'
      )
      .single();

    if (updateError) {
      console.error(`[NOWPayments Webhook] Update failed for ${invoiceId}:`, updateError.message);
      return res.status(200).json({ success: true, message: 'Update failed' });
    }

    console.log(
      `[NOWPayments Webhook] Invoice ${invoiceId} marked as paid (status=${paymentStatus})`
    );

    const paidInvoice = updatedInvoice || invoice;
    const freelancerId = paidInvoice.freelancer_id || invoice.freelancer_id;

    if (freelancerId) {
      try {
        const earningsResult = await updateUserEarnings(
          freelancerId,
          paidInvoice.amount ?? invoice.amount,
          paidInvoice.currency || invoice.currency || 'USD'
        );
        console.log(
          `[NOWPayments Webhook] Earnings updated for ${freelancerId} — tier ${earningsResult.tier}, +₦${earningsResult.earningsThisTransaction}`
        );
      } catch (earningsErr) {
        console.error(
          '[NOWPayments Webhook] Earnings update failed:',
          earningsErr.message
        );
      }
    }
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
          paidInvoice.paid_at || paidAt,
          paidInvoice.currency || invoice.currency || 'USD'
        );
        console.log(
          `[NOWPayments Webhook] Payment confirmation sent to ${freelancerEmail}`
        );
      } catch (emailErr) {
        console.error(
          '[NOWPayments Webhook] Payment confirmation email failed:',
          emailErr.message
        );
      }
    } else {
      console.warn(
        `[NOWPayments Webhook] No freelancer_email for invoice ${invoiceId}, skipping confirmation email`
      );
    }

    const freelancerPhone = paidInvoice.freelancer_phone || invoice.freelancer_phone;
    if (freelancerPhone) {
      try {
        await sendPaymentConfirmedWhatsApp(
          freelancerPhone,
          paidInvoice.client_name || invoice.client_name,
          paidInvoice.amount ?? invoice.amount,
          paidInvoice.currency || invoice.currency || 'USD'
        );
      } catch (waErr) {
        console.error(
          '[NOWPayments Webhook] Payment confirmation WhatsApp failed:',
          waErr.message
        );
      }
    }

    return res.status(200).json({ success: true, message: 'Payment processed' });
  } catch (err) {
    console.error('[NOWPayments Webhook] Unhandled error:', err.message);
    return res.status(200).json({ success: true, message: 'Error logged' });
  }
});

module.exports = router;

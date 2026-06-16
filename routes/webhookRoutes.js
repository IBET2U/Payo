const express = require('express');
const crypto = require('crypto');
const supabase = require('../supabase');
const { sendPaymentConfirmationEmail } = require('../mailer');
const { sendPaymentConfirmedWhatsApp } = require('../whatsapp');
const { updateUserEarnings } = require('../services/earningsService');
const { confirmCheckoutOrder } = require('../services/checkoutService');
const { createPaymentCommunityPost } = require('./communityRoutes');

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

  // Wallet top-up — handle before invoice lookup
  const topupUserId = data?.metadata?.topup_user_id;
  if (topupUserId) {
    const reference = data?.reference;
    const amtNgn = Number(data?.amount || 0) / 100;

    if (!reference || amtNgn <= 0) {
      console.error('[Paystack Webhook] Invalid topup data');
      return res.status(400).json({ success: false, error: 'Invalid topup data' });
    }

    try {
      // Dedup: check if this reference was already processed
      const { data: existing } = await supabase
        .from('transfers')
        .select('id')
        .eq('provider_reference', reference)
        .maybeSingle();

      if (existing) {
        console.log(`[Webhook Topup] Reference ${reference} already processed`);
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      // Credit wallet atomically
      const { data: profile } = await supabase
        .from('freelancer_profiles')
        .select('wallet_balance')
        .eq('id', topupUserId)
        .maybeSingle();

      const current = Number(profile?.wallet_balance || 0);
      await supabase
        .from('freelancer_profiles')
        .update({ wallet_balance: current + amtNgn })
        .eq('id', topupUserId);

      // Log for dedup + transfer history
      await supabase.from('transfers').insert({
        sender_id: topupUserId,
        recipient_type: 'wallet_topup',
        amount: amtNgn,
        status: 'success',
        provider: 'paystack',
        provider_reference: reference,
        reason: 'Wallet top-up via Paystack',
      });

      console.log(`[Webhook Topup] Credited ₦${amtNgn} to wallet of ${topupUserId}`);
      return res.status(200).json({ success: true, message: 'Wallet topped up' });
    } catch (err) {
      console.error('[Webhook Topup] Error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // Pay-and-send: sender paid via Paystack — execute the queued transfer now
  const pendingSenderId = data?.metadata?.pending_send_user_id;
  if (pendingSenderId) {
    const reference   = data?.reference;
    const amtNgn      = Number(data?.amount || 0) / 100;
    const meta        = data?.metadata || {};
    const recipientType = meta.pending_send_recipient_type;
    const recipientId   = meta.pending_send_recipient_id;
    const reason        = meta.pending_send_reason || null;

    if (!reference || amtNgn <= 0) {
      console.error('[Webhook PendingSend] Invalid data');
      return res.status(400).json({ success: false, error: 'Invalid send payment data' });
    }

    try {
      // Dedup
      const { data: existing } = await supabase
        .from('transfers')
        .select('id')
        .eq('provider_reference', reference)
        .maybeSingle();
      if (existing) {
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      if (recipientType === 'payo' && recipientId) {
        // Credit recipient's Payo wallet
        const { data: recipient } = await supabase
          .from('freelancer_profiles')
          .select('wallet_balance, phone, email, name')
          .eq('id', recipientId)
          .maybeSingle();

        if (recipient) {
          await supabase
            .from('freelancer_profiles')
            .update({ wallet_balance: Number(recipient.wallet_balance || 0) + amtNgn })
            .eq('id', recipientId);
        }

        await supabase.from('transfers').insert({
          sender_id:                pendingSenderId,
          recipient_type:           'payo',
          recipient_id:             recipientId,
          recipient_phone_or_email: recipient?.email || recipient?.phone || meta.pending_send_recipient_phone || null,
          amount:                   amtNgn,
          reason,
          status:                   'success',
          provider:                 'paystack_collect',
          provider_reference:       reference,
        });

      } else if (recipientType === 'external') {
        const accountNumber = meta.pending_send_account_number;
        const bankCode      = meta.pending_send_bank_code;
        const recipientName = meta.pending_send_name || 'Payo Recipient';
        let providerRef     = reference;
        let transferStatus  = 'success';

        if (accountNumber && bankCode) {
          try {
            const { createTransferRecipient } = require('../services/transferService');
            const axios       = require('axios');
            const recipientCode = await createTransferRecipient(accountNumber, bankCode, recipientName);
            const ps = axios.create({
              baseURL: 'https://api.paystack.co',
              headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
              timeout: 20000,
            });
            const transferRes = await ps.post('/transfer', {
              source: 'balance',
              amount: Math.round(amtNgn * 100),
              recipient: recipientCode,
              reason: reason || undefined,
            });
            providerRef = transferRes?.data?.data?.transfer_code || reference;
          } catch (txErr) {
            console.error('[Webhook PendingSend] External transfer failed:', txErr.message);
            transferStatus = 'failed';
          }
        }

        await supabase.from('transfers').insert({
          sender_id:                pendingSenderId,
          recipient_type:           'external',
          recipient_phone_or_email: meta.pending_send_recipient_phone || null,
          amount:                   amtNgn,
          reason,
          status:                   transferStatus,
          provider:                 'paystack',
          provider_reference:       providerRef,
        });
      }

      console.log(`[Webhook PendingSend] Executed ₦${amtNgn} transfer for sender ${pendingSenderId}`);
      return res.status(200).json({ success: true, message: 'Transfer executed' });
    } catch (err) {
      console.error('[Webhook PendingSend] Error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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
      .maybeSingle();

    if (fetchError) throw fetchError;

    if (!invoice) {
      try {
        const checkoutResult = await confirmCheckoutOrder(invoiceId);
        if (checkoutResult.handled) {
          console.log(`[Paystack Webhook] Checkout order ${invoiceId} processed`);
          return res.status(200).json({ success: true, message: 'Checkout order processed' });
        }
      } catch (checkoutErr) {
        console.error('[Paystack Webhook] Checkout confirm failed:', checkoutErr.message);
        return res.status(500).json({ success: false, error: checkoutErr.message });
      }
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
    const freelancerId = paidInvoice.freelancer_id || invoice.freelancer_id;

    if (freelancerId) {
      try {
        const earningsResult = await updateUserEarnings(
          freelancerId,
          paidInvoice.amount ?? invoice.amount,
          paidInvoice.currency || invoice.currency || 'NGN'
        );
        console.log(
          `[Paystack Webhook] Earnings updated for ${freelancerId} — tier ${earningsResult.tier}, +₦${earningsResult.earningsThisTransaction}`
        );
      } catch (earningsErr) {
        console.error(
          '[Paystack Webhook] Earnings update failed:',
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

    const invoiceAmount = Number(paidInvoice.amount ?? invoice.amount ?? 0);
    if (invoiceAmount > 0) {
      try {
        await createPaymentCommunityPost(
          {
            amount: invoiceAmount,
            currency: paidInvoice.currency || invoice.currency || 'NGN',
          },
          freelancerId
        );
        console.log(`[Paystack Webhook] Community post created for invoice ${invoiceId}`);
      } catch (communityErr) {
        console.error(
          '[Paystack Webhook] Community post failed:',
          communityErr.message
        );
      }
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

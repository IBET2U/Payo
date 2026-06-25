const express = require('express');
const router = express.Router();
const { createAndSendInvoice } = require('../services/invoiceService');
const {
  createPaymentLink,
  PAYO_PAYSTACK_FALLBACK_EMAIL,
} = require('../services/paymentProvider');
const supabase = require('../supabase');

router.post('/create', async (req, res) => {
  try {
    const {
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
    } = req.body;

    const result = await createAndSendInvoice({
      freelancer_id,
      freelancer_email,
      freelancer_name,
      client_name,
      client_email,
      client_phone,
      project_description,
      amount,
      due_date,
      currency: (currency || 'NGN').toUpperCase() === 'USD' ? 'USD' : 'NGN',
    });

    // Setup-required errors (bank_account_required / wallet_required / payment_link_failed)
    if (result.success === false) {
      return res.status(400).json(result);
    }

    const { invoice, payment_url } = result;

    res.json({
      success: true,
      message: 'Invoice created and sent to client successfully',
      invoice,
      payment_url,
    });
  } catch (error) {
    console.error('Invoice creation error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.post('/pay/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;

    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();

    if (error) throw error;
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found' });
    }

    if (invoice.status === 'paid') {
      return res.status(400).json({ success: false, error: 'Invoice is already paid' });
    }

    const currency = (invoice.currency || 'NGN').toUpperCase();

    // Duplicate payment prevention: reuse the existing link instead of
    // generating a new Paystack transaction every time this is called
    if (invoice.payment_url && invoice.status === 'unpaid') {
      return res.json({
        success: true,
        payment_url: invoice.payment_url,
        payment_reference: invoice.payment_reference,
        authorization_url: invoice.payment_url,
        provider: currency === 'USD' ? 'nowpayments' : 'paystack',
        invoice,
      });
    }
    const { paymentUrl, reference, provider } = await createPaymentLink({
      currency,
      clientEmail: invoice.client_email || PAYO_PAYSTACK_FALLBACK_EMAIL,
      amount: invoice.amount,
      invoiceId: invoice.id,
      clientName: invoice.client_name,
      description: invoice.project_description,
      freelancerId: invoice.freelancer_id,
    });

    const { data: updatedInvoice, error: updateError } = await supabase
      .from('invoices')
      .update({
        payment_url: paymentUrl,
        payment_reference: reference,
      })
      .eq('id', invoice.id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      success: true,
      payment_url: paymentUrl,
      payment_reference: reference,
      authorization_url: paymentUrl,
      provider,
      invoice: updatedInvoice,
    });
  } catch (error) {
    console.error('Payment link error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.get('/:freelancer_id', async (req, res) => {
  try {
    const authUserId = req.auth?.userId;
    const { freelancer_id } = req.params;

    // Users may only read their own invoices
    if (!authUserId || freelancer_id !== authUserId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const { data, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('freelancer_id', authUserId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, invoices: data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

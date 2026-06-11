const express = require('express');
const router = express.Router();
const { parseChatIntent } = require('../claude');
const { createAndSendInvoice } = require('../services/invoiceService');
const {
  formatAmountForCurrency,
  resolveCurrency,
} = require('../lib/currency');

const REQUIRED_INVOICE_FIELDS = [
  'client_name',
  'client_email',
  'amount',
  'due_date',
  'project_description',
];

function getMissingFields(extracted) {
  return REQUIRED_INVOICE_FIELDS.filter((field) => !extracted[field]);
}

function buildInvoiceConfirmationReply(amount, currency, clientName, clientEmail, dueDate) {
  const { display, code } = formatAmountForCurrency(amount, currency);
  const paymentNote =
    code === 'USD'
      ? 'They can pay via our USD payment link (NOWPayments).'
      : 'They can pay via Paystack in Naira.';

  return `Done! I've created and sent a ${display} invoice to ${clientName} (${clientEmail}). It's due ${dueDate}. ${paymentNote}`;
}

router.post('/', async (req, res) => {
  try {
    const {
      message,
      messages = [],
      freelancer_id,
      freelancer_email,
      freelancer_name,
    } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    if (!freelancer_id || !freelancer_email) {
      return res.status(400).json({
        success: false,
        error: 'freelancer_id and freelancer_email are required',
      });
    }

    const parsed = await parseChatIntent(message.trim(), messages);
    console.log('[CHAT DEBUG] Extracted fields:', JSON.stringify(parsed.extracted));

    if (parsed.intent === 'create_invoice') {
      const extracted = parsed.extracted || {};
      const missing = getMissingFields(extracted);
      const currency = resolveCurrency(extracted, message.trim(), messages);
      console.log('[CHAT DEBUG] Resolved currency:', currency, 'for message:', message);

      if (missing.length > 0) {
        const reply =
          parsed.reply ||
          `I can create that invoice — I just need: ${missing.join(', ').replace(/_/g, ' ')}.`;

        return res.json({
          success: true,
          intent: 'create_invoice',
          incomplete: true,
          missing,
          reply,
          messages: [
            ...messages,
            { role: 'user', content: message },
            { role: 'assistant', content: reply },
          ],
        });
      }

      console.log('[CHAT DEBUG] Calling createAndSendInvoice with currency:', currency);
      const result = await createAndSendInvoice({
        freelancer_id,
        freelancer_email,
        freelancer_name,
        client_name: extracted.client_name,
        client_email: extracted.client_email,
        client_phone: extracted.client_phone,
        project_description: extracted.project_description,
        amount: extracted.amount,
        due_date: extracted.due_date,
        currency,
      });

      if (result.success === false) {
        const reply = result.message || 'Please finish your payment setup first.';
        return res.json({
          success: true,
          intent: 'create_invoice',
          setup_required: result.error,
          reply,
          messages: [
            ...messages,
            { role: 'user', content: message },
            { role: 'assistant', content: reply },
          ],
        });
      }

      const { invoice, payment_url } = result;

      const reply = buildInvoiceConfirmationReply(
        extracted.amount,
        currency,
        extracted.client_name,
        extracted.client_email,
        extracted.due_date
      );

      return res.json({
        success: true,
        intent: 'create_invoice',
        currency,
        reply,
        invoice,
        payment_url,
        messages: [
          ...messages,
          { role: 'user', content: message },
          { role: 'assistant', content: reply },
        ],
      });
    }

    const reply =
      parsed.reply ||
      "I'm here to help you get paid. Tell me who to invoice, their email, the amount, due date, and what the work was for.";

    return res.json({
      success: true,
      intent: parsed.intent || 'general',
      reply,
      messages: [
        ...messages,
        { role: 'user', content: message },
        { role: 'assistant', content: reply },
      ],
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();

const {
  resolveRecipient,
  initiateTransfer,
  getTransferHistory,
  createWalletTopup,
  createSendPaymentLink,
} = require('../services/transferService');
const { updateUserEarnings } = require('../services/earningsService');

router.post('/resolve', async (req, res) => {
  try {
    const { phoneOrEmail, accountNumber, bankCode } = req.body || {};
    const resolved = await resolveRecipient(phoneOrEmail, { accountNumber, bankCode });

    const previewName =
      resolved.type === 'payo'
        ? resolved.profile?.name || resolved.profile?.email || resolved.profile?.phone || null
        : resolved.bank?.accountName || null;

    return res.json({ success: true, recipient: resolved, previewName });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    console.log('[TRANSFER] Clerk userId:', req.auth?.userId);
    const senderId = req.auth?.userId;
    const { recipient, amount, reason, accountNumber, bankCode, name } = req.body || {};

    if (!senderId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!recipient) {
      return res.status(400).json({ success: false, error: 'recipient is required' });
    }

    const resolved = await resolveRecipient(recipient, { accountNumber, bankCode });

    if (resolved.type === 'external' && (!accountNumber || !bankCode)) {
      return res.status(200).json({
        success: false,
        needs_bank_details: true,
        message: 'External recipient detected. Please provide bank details to continue.',
        recipient: resolved,
      });
    }

    const result = await initiateTransfer(senderId, resolved, amount, reason, {
      accountNumber,
      bankCode,
      name,
    });

    if (resolved.type === 'payo' && resolved.profile?.id) {
      try {
        const earningsResult = await updateUserEarnings(
          resolved.profile.id,
          amount,
          'NGN',
          { isNetworkTransaction: true }
        );
        if (earningsResult) {
          console.log(
            `[Transfer] Network earnings updated for ${resolved.profile.id} — tier ${earningsResult.tier}, +₦${earningsResult.earningsThisTransaction}`
          );
        }
      } catch (earningsErr) {
        console.error('[Transfer] Earnings update failed:', earningsErr.message);
      }
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[TRANSFER ERROR]', err.message, err.stack);
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Collect send amount from sender via Paystack; webhook auto-executes the transfer on confirm
router.post('/pay-and-send', async (req, res) => {
  try {
    const senderId = req.auth?.userId;
    if (!senderId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { recipient, amount, reason, accountNumber, bankCode, name } = req.body || {};
    if (!recipient) return res.status(400).json({ success: false, error: 'recipient is required' });

    const resolved = await resolveRecipient(recipient, { accountNumber, bankCode });

    if (resolved.type === 'external' && (!accountNumber || !bankCode)) {
      return res.status(200).json({
        success: false,
        needs_bank_details: true,
        message: 'External recipient detected. Please provide bank details to continue.',
        recipient: resolved,
      });
    }

    const { paymentUrl, reference } = await createSendPaymentLink(
      senderId, resolved, amount, reason, { accountNumber, bankCode, name }
    );

    return res.json({ success: true, payment_url: paymentUrl, reference, requires_paystack: true });
  } catch (err) {
    console.error('[PayAndSend] Error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/topup', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    const { amount } = req.body || {};
    const { paymentUrl, reference } = await createWalletTopup(userId, amount);
    return res.json({ success: true, payment_url: paymentUrl, reference });
  } catch (err) {
    console.error('[Topup] Error:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const senderId = req.auth?.userId;
    if (!senderId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const history = await getTransferHistory(senderId, 50);
    return res.json({ success: true, transfers: history });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;


const express = require('express');
const router = express.Router();

const {
  resolveRecipient,
  initiateTransfer,
  getTransferHistory,
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
    const senderId = req.body?.senderId || req.body?.freelancer_id || req.auth?.userId;
    const { recipient, amount, reason, accountNumber, bankCode, name } = req.body || {};

    if (!senderId) {
      return res.status(400).json({ success: false, error: 'senderId is required' });
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

    if (result.transfer?.recipient_type === 'payo' && result.transfer?.recipient_id) {
      try {
        const earningsResult = await updateUserEarnings(
          result.transfer.recipient_id,
          amount,
          'NGN',
          { isNetworkTransaction: true }
        );
        console.log(
          `[Transfer] Network earnings updated for ${result.transfer.recipient_id} — tier ${earningsResult.tier}, +₦${earningsResult.earningsThisTransaction}`
        );
      } catch (earningsErr) {
        console.error('[Transfer] Earnings update failed:', earningsErr.message);
      }
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const senderId = req.query?.senderId || req.auth?.userId;
    if (!senderId) {
      return res.status(400).json({ success: false, error: 'senderId is required' });
    }

    const history = await getTransferHistory(senderId, 50);
    return res.json({ success: true, transfers: history });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;


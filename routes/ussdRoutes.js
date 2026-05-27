const express = require('express');
const router = express.Router();
const { handleUssdRequest } = require('../ussd');

router.use(express.urlencoded({ extended: false }));

router.post('/', async (req, res) => {
  const sessionId = req.body.sessionId || '';
  const serviceCode = req.body.serviceCode || '';
  const phoneNumber = req.body.phoneNumber || '';
  const text = req.body.text || '';

  res.set('Content-Type', 'text/plain');

  try {
    const response = await handleUssdRequest({
      sessionId,
      serviceCode,
      phoneNumber,
      text,
    });
    return res.send(response);
  } catch (err) {
    console.error('[USSD ERROR] Unhandled error in /ussd handler:', err);
    return res.send('END Something went wrong. Please try again later.');
  }
});

module.exports = router;

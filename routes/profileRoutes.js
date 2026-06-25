const express = require('express');
const multer = require('multer');
const { clerkClient } = require('@clerk/clerk-sdk-node');
const supabase = require('../supabase');
const router = express.Router();
const {
  getProfile,
  createOrUpdateProfile,
  updateLogoUrl,
} = require('../services/profileService');
const { ensureLogosBucket } = require('../services/storageService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

function extFromMime(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return map[mime] || '';
}

function handleBrandingUpdate(req, res) {
  return (async () => {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        return res.status(401).json({ success: false, error: 'Unauthenticated' });
      }

      const raw = req.body || {};
      const existing = await getProfile(userId);
      const payload = {};

      if (raw.wallet_address !== undefined || raw.phone !== undefined || raw.name !== undefined || raw.email !== undefined || raw.language !== undefined) {
        const resolvedEmail = raw.email ?? existing?.email ?? req.auth?.sessionClaims?.email ?? null;
        const resolvedName = raw.name ?? existing?.name ?? null;
        const resolvedPhone = raw.phone !== undefined ? raw.phone : existing?.phone ?? null;
        const resolvedWallet = raw.wallet_address !== undefined ? raw.wallet_address : existing?.wallet_address ?? null;
        const resolvedLanguage = raw.language ?? existing?.language ?? 'english';

        const safeEmail = String(resolvedEmail || '').trim().toLowerCase().slice(0, 200);
        if (safeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
          return res.status(400).json({ success: false, error: 'A valid email is required' });
        }

        payload.email = safeEmail || null;
        payload.name = String(resolvedName || '').trim().slice(0, 100) || null;
        payload.phone = String(resolvedPhone || '').trim().replace(/[^\d+]/g, '').slice(0, 20) || null;
        payload.wallet_address = String(resolvedWallet || '').trim().slice(0, 120) || null;
        payload.language = String(resolvedLanguage || 'english').trim().slice(0, 20);
      }

      const brandingFields = [
        'business_name',
        'business_address',
        'business_phone',
        'business_website',
        'invoice_color',
        'invoice_note',
        'logo_url',
      ];
      for (const field of brandingFields) {
        if (raw[field] !== undefined) payload[field] = raw[field];
      }

      if (payload.invoice_color !== undefined) {
        const color = String(payload.invoice_color || '').trim();
        if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
          return res.status(400).json({ success: false, error: 'invoice_color must be a hex color like #00a884' });
        }
        payload.invoice_color = color || '#00a884';
      }

      const profile = await createOrUpdateProfile(userId, payload);

      res.json({
        success: true,
        profile,
        has_wallet: !!(profile?.wallet_address && String(profile.wallet_address).trim()),
        has_bank: !!(profile?.subaccount_code && String(profile.subaccount_code).trim()),
      });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  })();
}

// New users often hit bank setup before any profile row exists, and Clerk
// session claims don't carry an email — resolve it from every source we have.
async function resolveUserEmail(req, existingProfile, bodyEmail) {
  const candidates = [
    existingProfile?.email,
    bodyEmail,
    req.auth?.sessionClaims?.email,
  ];

  for (const candidate of candidates) {
    const email = String(candidate || '').trim().toLowerCase();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  }

  try {
    const user = await clerkClient.users.getUser(req.auth.userId);
    const clerkEmail =
      user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress || user?.emailAddresses?.[0]?.emailAddress;
    if (clerkEmail) return String(clerkEmail).trim().toLowerCase();
  } catch (err) {
    console.warn('[Profile] Clerk email lookup failed:', err.message);
  }

  return null;
}
const {
  saveBankDetails,
  getBanks,
  verifyBankAccount,
} = require('../services/subaccountService');

router.get('/', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const profile = await getProfile(userId);

    res.json({
      success: true,
      profile: profile || null,
      has_wallet: !!(profile?.wallet_address && String(profile.wallet_address).trim()),
      has_bank: !!(profile?.subaccount_code && String(profile.subaccount_code).trim()),
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/verify-bank', async (req, res) => {
  try {
    const { account_number, bank_code } = req.query;
    const result = await verifyBankAccount(account_number, bank_code);

    res.json({
      success: true,
      account_name: result.account_name,
      account_number: result.account_number,
    });
  } catch (error) {
    console.error('[Profile] Verify bank error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/banks', async (req, res) => {
  try {
    const banks = await getBanks();
    res.json({ success: true, banks });
  } catch (error) {
    console.error('[Profile] Get banks error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/bank/verify', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const { account_number, bank_code } = req.body || {};
    const result = await verifyBankAccount(account_number, bank_code);

    res.json({
      success: true,
      account_name: result.account_name,
      account_number: result.account_number,
    });
  } catch (error) {
    console.error('[Profile] Verify bank error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/bank', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const raw = req.body || {};
    const bank_code = String(raw.bank_code || '').trim().slice(0, 10);
    const account_number = String(raw.account_number || '').trim().replace(/\D/g, '').slice(0, 10);
    const business_name = String(raw.business_name || '').trim().slice(0, 100);

    if (!bank_code || !account_number) {
      return res.status(400).json({
        success: false,
        error: 'bank_code and account_number are required',
      });
    }

    const existing = await getProfile(userId);
    const email = await resolveUserEmail(req, existing, raw.email);

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'We could not find your email. Please update your profile and try again.',
      });
    }

    const result = await saveBankDetails(userId, {
      accountNumber: account_number,
      bankCode: bank_code,
      businessName: business_name,
      email,
    });

    res.json({
      success: true,
      subaccount_code: result.subaccount_code,
      account_name: result.account_name,
      bank_name: result.bank_name,
      profile: result.profile,
      has_bank: true,
    });
  } catch (error) {
    console.error('[Profile] Save bank error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/update', (req, res) => handleBrandingUpdate(req, res));

router.post('/logo', (req, res, next) => {
  upload.single('logo')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No logo file provided' });
    }

    await ensureLogosBucket();

    const ext = extFromMime(file.mimetype);
    const path = `${userId}-${Date.now()}${ext}`;

    const { data, error } = await supabase.storage
      .from('logos')
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) throw error;

    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(data.path);
    const logoUrl = urlData.publicUrl;

    await updateLogoUrl(userId, logoUrl);

    res.json({ success: true, logo_url: logoUrl });
  } catch (error) {
    console.error('[Profile] Logo upload error:', error);
    const msg = error.message || 'Upload failed';
    const friendly = /bucket not found/i.test(msg)
      ? 'Logo storage is not set up. Restart the server and try again.'
      : msg;
    res.status(500).json({ success: false, error: friendly });
  }
});

router.post('/', (req, res) => handleBrandingUpdate(req, res));

module.exports = router;

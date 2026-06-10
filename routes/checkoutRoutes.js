const express = require('express');
const supabase = require('../supabase');
const { getProfile } = require('../services/profileService');
const {
  createPaymentLink,
  PAYO_PAYSTACK_FALLBACK_EMAIL,
} = require('../services/paymentProvider');
const {
  generateCheckoutSlug,
  getSellerUsername,
  buildCheckoutUrl,
  calculatePricing,
  confirmCheckoutOrder,
  DOWNLOAD_LIMIT,
} = require('../services/checkoutService');
const { normalizeCurrency } = require('../lib/currency');

const router = express.Router();

router.get('/data/:username/:slug', async (req, res) => {
  try {
    const { username, slug } = req.params;

    const { data, error } = await supabase
      .from('checkouts')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'Checkout not found' });
    }

    const profile = await getProfile(data.seller_id);
    const sellerUsername = getSellerUsername(profile);

    if (sellerUsername !== String(username).toLowerCase()) {
      return res.status(404).json({ success: false, error: 'Checkout not found' });
    }

    const checkout = {
      ...data,
      price: Number(data.price),
      seller_name: profile?.name || profile?.business_name || sellerUsername,
    };

    res.json({ success: true, checkout });
  } catch (err) {
    console.error('[Checkout] Data fetch failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

function requireAuth(req, res, next) {
  if (!req.auth?.userId) {
    return res.status(401).json({ success: false, error: 'Unauthenticated' });
  }
  next();
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

router.post('/create', requireAuth, async (req, res) => {
  try {
    const sellerId = req.auth.userId;
    const {
      product_name,
      description,
      price,
      currency,
      collect_name = true,
      collect_email = true,
      collect_phone = true,
      thank_you_message,
      stock_limit,
      is_digital = false,
      download_url,
      add_vat = false,
    } = req.body;

    if (!product_name || !String(product_name).trim()) {
      return res.status(400).json({ success: false, error: 'product_name is required' });
    }

    const numPrice = Number(price);
    if (!Number.isFinite(numPrice) || numPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Valid price is required' });
    }

    const normalizedCurrency = normalizeCurrency(currency);
    const digital = !!is_digital;
    const vatEnabled = !!add_vat;

    if (digital && !download_url) {
      return res.status(400).json({ success: false, error: 'download_url is required for digital products' });
    }

    const profile = await getProfile(sellerId);
    const username = getSellerUsername(profile);

    let slug = generateCheckoutSlug(product_name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: existing } = await supabase
        .from('checkouts')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      if (!existing) break;
      slug = generateCheckoutSlug(product_name);
    }

    const stockLimitNum =
      stock_limit != null && stock_limit !== '' ? Number(stock_limit) : null;

    const record = {
      seller_id: sellerId,
      product_name: String(product_name).trim(),
      description: description ? String(description).trim() : null,
      price: numPrice,
      currency: normalizedCurrency,
      slug,
      collect_name: !!collect_name,
      collect_email: digital ? true : !!collect_email,
      collect_phone: !!collect_phone,
      thank_you_message: thank_you_message ? String(thank_you_message).trim() : null,
      stock_limit: Number.isFinite(stockLimitNum) && stockLimitNum > 0 ? stockLimitNum : null,
      stock_remaining:
        Number.isFinite(stockLimitNum) && stockLimitNum > 0 ? stockLimitNum : null,
      is_digital: digital,
      download_url: digital && download_url ? String(download_url).trim() : null,
      add_vat: vatEnabled,
      vat_rate: vatEnabled ? 0.075 : null,
      is_active: true,
      total_sales: 0,
      total_revenue: 0,
    };

    const { data: checkout, error } = await supabase
      .from('checkouts')
      .insert(record)
      .select()
      .single();

    if (error) throw error;

    const url = buildCheckoutUrl(username, slug);

    res.json({
      success: true,
      checkout: {
        ...checkout,
        username,
        url,
      },
    });
  } catch (err) {
    console.error('[Checkout] Create failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/my', requireAuth, async (req, res) => {
  try {
    const sellerId = req.auth.userId;

    const { data: checkouts, error } = await supabase
      .from('checkouts')
      .select('*')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const profile = await getProfile(sellerId);
    const username = getSellerUsername(profile);

    const enriched = (checkouts || []).map((c) => ({
      ...c,
      username,
      url: buildCheckoutUrl(username, c.slug),
      total_sales: Number(c.total_sales || 0),
      total_revenue: Number(c.total_revenue || 0),
    }));

    res.json({ success: true, checkouts: enriched });
  } catch (err) {
    console.error('[Checkout] List failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/:checkoutId/status', requireAuth, async (req, res) => {
  try {
    const sellerId = req.auth.userId;
    const { checkoutId } = req.params;
    const { is_active } = req.body;

    const { data: checkout, error: fetchError } = await supabase
      .from('checkouts')
      .select('id, seller_id')
      .eq('id', checkoutId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!checkout || checkout.seller_id !== sellerId) {
      return res.status(404).json({ success: false, error: 'Checkout not found' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('checkouts')
      .update({ is_active: !!is_active })
      .eq('id', checkoutId)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({ success: true, checkout: updated });
  } catch (err) {
    console.error('[Checkout] Status update failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/orders/:checkoutId', requireAuth, async (req, res) => {
  try {
    const sellerId = req.auth.userId;
    const { checkoutId } = req.params;

    const { data: checkout, error: checkoutError } = await supabase
      .from('checkouts')
      .select('*')
      .eq('id', checkoutId)
      .maybeSingle();

    if (checkoutError) throw checkoutError;
    if (!checkout || checkout.seller_id !== sellerId) {
      return res.status(404).json({ success: false, error: 'Checkout not found' });
    }

    const { data: orders, error: ordersError } = await supabase
      .from('checkout_orders')
      .select('*')
      .eq('checkout_id', checkoutId)
      .order('created_at', { ascending: false });

    if (ordersError) throw ordersError;

    const enriched = (orders || []).map((o) => ({
      ...o,
      download_stats: checkout.is_digital
        ? {
            download_count: Number(o.download_count || 0),
            download_limit: DOWNLOAD_LIMIT,
            has_token: !!o.download_token,
            expires_at: o.download_expires_at,
          }
        : null,
    }));

    res.json({
      success: true,
      checkout,
      orders: enriched,
    });
  } catch (err) {
    console.error('[Checkout] Orders list failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/download/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const { data: order, error } = await supabase
      .from('checkout_orders')
      .select('*')
      .eq('download_token', token)
      .maybeSingle();

    if (error) throw error;

    let checkout = null;
    if (order?.checkout_id) {
      const { data: checkoutRow } = await supabase
        .from('checkouts')
        .select('download_url, product_name, seller_id')
        .eq('id', order.checkout_id)
        .maybeSingle();
      checkout = checkoutRow;
    }
    const sellerProfile = checkout?.seller_id
      ? await getProfile(checkout.seller_id)
      : null;
    const sellerName = sellerProfile?.name || 'the seller';
    const sellerEmail = sellerProfile?.email || 'support@payoapp.org';

    const expiredPage = (reason) => `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Download expired — Payo</title>
        <style>
          body { font-family: -apple-system, sans-serif; background: #0b141a; color: #e9edef; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
          .box { max-width: 400px; text-align: center; background: #1f2c34; border: 1px solid #2a3942; border-radius: 16px; padding: 32px 24px; }
          h1 { font-size: 20px; margin: 0 0 12px; }
          p { color: #8696a0; line-height: 1.5; font-size: 15px; }
          a { color: #00a884; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Download unavailable</h1>
          <p>${reason} Please contact ${escapeHtml(sellerName)} at <a href="mailto:${escapeHtml(sellerEmail)}">${escapeHtml(sellerEmail)}</a>.</p>
        </div>
      </body>
      </html>
    `;

    if (!order || !checkout?.download_url) {
      return res.status(404).send(expiredPage('This download link has expired.'));
    }

    const now = Date.now();
    const expiresAt = order.download_expires_at
      ? new Date(order.download_expires_at).getTime()
      : 0;

    if (!expiresAt || expiresAt <= now) {
      return res.status(410).send(expiredPage('This download link has expired.'));
    }

    if (Number(order.download_count || 0) >= DOWNLOAD_LIMIT) {
      return res.status(410).send(expiredPage('This download link has reached its limit.'));
    }

    const { error: countError } = await supabase
      .from('checkout_orders')
      .update({ download_count: Number(order.download_count || 0) + 1 })
      .eq('id', order.id);

    if (countError) throw countError;

    return res.redirect(302, checkout.download_url);
  } catch (err) {
    console.error('[Checkout] Download failed:', err.message);
    res.status(500).send('Something went wrong. Please try again later.');
  }
});

router.post('/confirm/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await confirmCheckoutOrder(orderId);

    if (!result.handled) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Checkout] Confirm failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:slug/pay', async (req, res) => {
  try {
    const { slug } = req.params;
    const { customer_name, customer_email, customer_phone } = req.body;

    const { data: checkout, error } = await supabase
      .from('checkouts')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw error;
    if (!checkout || !checkout.is_active) {
      return res.status(404).json({ success: false, error: 'Checkout not found' });
    }

    if (checkout.stock_limit != null && checkout.stock_remaining != null) {
      if (Number(checkout.stock_remaining) <= 0) {
        return res.status(400).json({ success: false, error: 'Out of stock' });
      }
    }

    if (checkout.is_digital && !customer_email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required for digital products',
      });
    }

    const pricing = calculatePricing(checkout.price, checkout.add_vat);

    const { data: order, error: orderError } = await supabase
      .from('checkout_orders')
      .insert({
        checkout_id: checkout.id,
        seller_id: checkout.seller_id,
        customer_name: customer_name ? String(customer_name).trim() : null,
        customer_email: customer_email ? String(customer_email).trim() : null,
        customer_phone: customer_phone ? String(customer_phone).trim() : null,
        amount: pricing.final_amount,
        vat_amount: pricing.vat_amount,
        base_amount: pricing.base_amount,
        currency: checkout.currency || 'NGN',
        status: 'pending',
      })
      .select()
      .single();

    if (orderError) throw orderError;

    const { paymentUrl, reference } = await createPaymentLink({
      amount: pricing.final_amount,
      currency: checkout.currency,
      clientEmail: customer_email || PAYO_PAYSTACK_FALLBACK_EMAIL,
      invoiceId: order.id,
      clientName: customer_name || 'Customer',
      description: checkout.product_name,
      freelancerId: checkout.seller_id,
    });

    const { error: updateError } = await supabase
      .from('checkout_orders')
      .update({
        payment_url: paymentUrl,
        payment_reference: reference,
      })
      .eq('id', order.id);

    if (updateError) throw updateError;

    res.json({
      success: true,
      payment_url: paymentUrl,
      order_id: order.id,
    });
  } catch (err) {
    console.error('[Checkout] Pay failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

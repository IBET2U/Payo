const crypto = require('crypto');
const supabase = require('../supabase');
const { sendCheckoutDownloadEmail } = require('../mailer');
const {
  sendCheckoutDownloadWhatsApp,
  sendCheckoutSaleWhatsApp,
} = require('../whatsapp');
const { updateUserEarnings } = require('./earningsService');
const { getProfile } = require('./profileService');
const { formatAmountForCurrency } = require('../lib/currency');

const PAYO_APP_URL = process.env.PAYO_APP_URL || 'https://payoapp.org';
const DOWNLOAD_LIMIT = 3;
const DOWNLOAD_HOURS = 48;

function roundNaira(amount) {
  return Math.round(Number(amount));
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function generateCheckoutSlug(productName) {
  const base = slugify(productName) || 'product';
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${base}-${suffix}`;
}

function getSellerUsername(profile) {
  if (profile?.username && String(profile.username).trim()) {
    return String(profile.username).trim().toLowerCase();
  }
  const base =
    profile?.name ||
    (profile?.email ? profile.email.split('@')[0] : null) ||
    'seller';
  return slugify(base) || 'seller';
}

function buildCheckoutUrl(username, slug) {
  return `https://payoapp.org/checkout/${username}/${slug}`;
}

function calculatePricing(price, addVat) {
  const base = Number(price);
  if (!addVat) {
    return {
      base_amount: base,
      vat_amount: 0,
      final_amount: base,
      displayed_price: { base, vat: 0, total: base },
    };
  }
  const vat = base * 0.075;
  const total = roundNaira(base * 1.075);
  return {
    base_amount: base,
    vat_amount: vat,
    final_amount: total,
    displayed_price: { base, vat, total },
  };
}

async function confirmCheckoutOrder(orderId) {
  const { data: order, error: orderError } = await supabase
    .from('checkout_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError) throw orderError;
  if (!order) {
    return { handled: false, reason: 'not_found' };
  }

  if (order.status === 'paid') {
    console.log(`[Checkout] Order ${orderId} already paid`);
    return { handled: true, alreadyPaid: true };
  }

  const { data: checkout, error: checkoutError } = await supabase
    .from('checkouts')
    .select('*')
    .eq('id', order.checkout_id)
    .single();

  if (checkoutError) throw checkoutError;

  const paidAt = new Date().toISOString();

  const { error: orderUpdateError } = await supabase
    .from('checkout_orders')
    .update({
      status: 'paid',
      paid_at: paidAt,
    })
    .eq('id', orderId);

  if (orderUpdateError) throw orderUpdateError;

  const newSales = Number(checkout.total_sales || 0) + 1;
  const newRevenue = Number(checkout.total_revenue || 0) + Number(order.amount || 0);

  const checkoutUpdate = {
    total_sales: newSales,
    total_revenue: newRevenue,
  };

  if (checkout.stock_limit != null && checkout.stock_remaining != null) {
    checkoutUpdate.stock_remaining = Math.max(0, Number(checkout.stock_remaining) - 1);
  }

  const { error: checkoutStatsError } = await supabase
    .from('checkouts')
    .update(checkoutUpdate)
    .eq('id', checkout.id);

  if (checkoutStatsError) throw checkoutStatsError;

  const sellerProfile = await getProfile(order.seller_id);
  const sellerName = sellerProfile?.name || sellerProfile?.business_name || 'Seller';

  let downloadToken = null;
  if (checkout.is_digital && checkout.download_url) {
    downloadToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + DOWNLOAD_HOURS * 60 * 60 * 1000).toISOString();

    const { error: tokenError } = await supabase
      .from('checkout_orders')
      .update({
        download_token: downloadToken,
        download_expires_at: expiresAt,
        download_count: 0,
      })
      .eq('id', orderId);

    if (tokenError) throw tokenError;

    const downloadUrl = `${PAYO_APP_URL}/checkout/download/${downloadToken}`;

    if (order.customer_email) {
      try {
        await sendCheckoutDownloadEmail(
          order.customer_email,
          checkout.product_name,
          downloadUrl
        );
      } catch (emailErr) {
        console.error('[Checkout] Download email failed:', emailErr.message);
      }
    }

    if (order.customer_phone) {
      try {
        await sendCheckoutDownloadWhatsApp(
          order.customer_phone,
          order.customer_name || 'there',
          checkout.product_name,
          downloadUrl,
          sellerName
        );
      } catch (waErr) {
        console.error('[Checkout] Download WhatsApp failed:', waErr.message);
      }
    }
  }

  if (sellerProfile?.phone) {
    try {
      const { display } = formatAmountForCurrency(order.amount, order.currency);
      await sendCheckoutSaleWhatsApp(
        sellerProfile.phone,
        order.customer_name || 'Customer',
        display,
        checkout.product_name,
        checkout.is_digital && !!checkout.download_url
      );
    } catch (waErr) {
      console.error('[Checkout] Seller sale WhatsApp failed:', waErr.message);
    }
  }

  if (order.seller_id) {
    try {
      await updateUserEarnings(order.seller_id, order.amount, order.currency || 'NGN');
    } catch (earningsErr) {
      console.error('[Checkout] Earnings update failed:', earningsErr.message);
    }
  }

  console.log(`[Checkout] Order ${orderId} confirmed for ${checkout.product_name}`);
  return { handled: true, orderId, checkout, downloadToken };
}

module.exports = {
  generateCheckoutSlug,
  getSellerUsername,
  buildCheckoutUrl,
  calculatePricing,
  confirmCheckoutOrder,
  roundNaira,
  DOWNLOAD_LIMIT,
};

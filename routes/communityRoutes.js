const express = require('express');
const supabase = require('../supabase');

const router = express.Router();

const VALID_REACTIONS = new Set(['green', 'fire', 'clap']);
const REACTION_COLUMNS = {
  green: 'green_count',
  fire: 'fire_count',
  clap: 'clap_count',
};

function formatAmountForMessage(amount, currency) {
  const cur = String(currency || 'NGN').toUpperCase();
  const num = Number(amount || 0);
  if (cur === 'USD') {
    return `$${num.toLocaleString('en-US')}`;
  }
  return `₦${num.toLocaleString('en-NG')}`;
}

function buildPaymentMessage(amount, currency) {
  const cur = String(currency || 'NGN').toUpperCase();
  const formatted = formatAmountForMessage(amount, currency);
  if (cur === 'USD') {
    return `Just received ${formatted} internationally through Payo 🌍`;
  }
  return `Just got paid ${formatted} for client work through Payo 💚`;
}

async function fetchFreelancerTier(freelancerId) {
  if (!freelancerId) return 'BRONZE';

  const { data: profile, error } = await supabase
    .from('freelancer_profiles')
    .select('tier')
    .eq('id', freelancerId)
    .maybeSingle();

  if (error) {
    console.warn('[Community] Could not load tier:', error.message);
    return 'BRONZE';
  }

  return String(profile?.tier || 'BRONZE').toUpperCase();
}

async function createPaymentCommunityPost(invoice, freelancerId) {
  const amount = Number(invoice.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = invoice.currency || 'NGN';
  const tier = await fetchFreelancerTier(freelancerId);
  const message = buildPaymentMessage(amount, currency);

  const { data: post, error } = await supabase
    .from('community_posts')
    .insert({
      freelancer_id: freelancerId || null,
      post_type: 'payment',
      amount,
      currency,
      tier,
      message,
      is_anonymous: true,
      display_name: null,
      city: null,
    })
    .select('*')
    .single();

  if (error) {
    throw error;
  }

  return post;
}

router.get('/feed', async (req, res) => {
  try {
    const { data: posts, error } = await supabase
      .from('community_posts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ success: true, posts: posts || [] });
  } catch (err) {
    console.error('[Community] Feed error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/post', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const {
      post_type,
      amount,
      currency,
      city,
      message,
      is_anonymous,
      display_name,
    } = req.body || {};

    const trimmedMessage = String(message || '').trim();
    if (!trimmedMessage) {
      return res.status(400).json({ success: false, error: 'message is required' });
    }

    const tier = await fetchFreelancerTier(userId);
    const anonymous = is_anonymous !== false;

    const { data: post, error } = await supabase
      .from('community_posts')
      .insert({
        freelancer_id: userId,
        post_type: post_type || 'win',
        amount: amount != null ? Number(amount) : null,
        currency: currency || null,
        tier,
        city: city ? String(city).trim() : null,
        message: trimmedMessage,
        is_anonymous: anonymous,
        display_name: anonymous ? null : (display_name ? String(display_name).trim() : null),
      })
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, post });
  } catch (err) {
    console.error('[Community] Post error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/react/:postId', async (req, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const { postId } = req.params;
    const reaction = String(req.body?.reaction || '').toLowerCase();

    if (!VALID_REACTIONS.has(reaction)) {
      return res.status(400).json({
        success: false,
        error: "reaction must be one of: 'green', 'fire', 'clap'",
      });
    }

    const column = REACTION_COLUMNS[reaction];

    const { data: existing, error: fetchError } = await supabase
      .from('community_posts')
      .select('*')
      .eq('id', postId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Post not found' });
    }

    const nextCount = Number(existing[column] || 0) + 1;

    const { data: post, error: updateError } = await supabase
      .from('community_posts')
      .update({ [column]: nextCount })
      .eq('id', postId)
      .select('*')
      .single();

    if (updateError) throw updateError;

    res.json({ success: true, post });
  } catch (err) {
    console.error('[Community] React error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.createPaymentCommunityPost = createPaymentCommunityPost;
module.exports.buildPaymentMessage = buildPaymentMessage;

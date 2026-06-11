const Sentry = require('@sentry/node');
Sentry.init({ 
  dsn: 'https://20572c681aea863a65f724d04d764512@o4511527778779136.ingest.us.sentry.io/4511527788085248',
  tracesSampleRate: 1.0
});
require('dotenv').config();

// Fail fast if critical secrets are missing — a half-configured server is dangerous
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'ANTHROPIC_API_KEY',
  'PAYSTACK_SECRET_KEY',
  'CLERK_SECRET_KEY',
  'RESEND_API_KEY',
];
const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  process.exit(1);
}

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getBanks } = require('./services/subaccountService');
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const invoiceRoutes = require('./routes/invoiceRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const nowpaymentsWebhookRoutes = require('./routes/nowpaymentsWebhook');
const chatRoutes = require('./routes/chatRoutes');
const profileRoutes = require('./routes/profileRoutes');
const ussdRoutes = require('./routes/ussdRoutes');
const transferRoutes = require('./routes/transferRoutes');
const earningsRoutes = require('./routes/earningsRoutes');
const communityRoutes = require('./routes/communityRoutes');
const checkoutRoutes = require('./routes/checkoutRoutes');
require('./followUp');

const app = express();
const PORT = process.env.PORT || 3000;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function rateLimitHandler(req, res) {
  res.status(429).json({ success: false, error: 'Too many requests. Slow down small.' });
}

function createRateLimiter(max) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max,
    handler: rateLimitHandler,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

const generalLimiter = createRateLimiter(100);
const chatLimiter = createRateLimiter(20);
const invoicesLimiter = createRateLimiter(30);
const transfersLimiter = createRateLimiter(20);
const profileLimiter = createRateLimiter(20);
const communityLimiter = createRateLimiter(60);
const checkoutLimiter = createRateLimiter(60);

const clerkRequireAuth = ClerkExpressRequireAuth();
const publicDir = path.join(__dirname, 'public');
const checkoutHtmlPath = path.resolve(publicDir, 'checkout.html');
const serveStatic = express.static(publicDir);

const PUBLIC_PATHS = new Set(['/health', '/config', '/ussd', '/banks', '/profile/verify-bank']);

function isPublicRoute(path) {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith('/webhooks/paystack')) return true;
  if (path.startsWith('/ussd/')) return true;
  return false;
}

const CHECKOUT_RESERVED_SEGMENTS = new Set(['create', 'my', 'orders', 'confirm', 'download', 'api', 'data']);

function isCheckoutProductPath(path) {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 2 && !CHECKOUT_RESERVED_SEGMENTS.has(segments[0])) {
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === 'checkout' &&
    !CHECKOUT_RESERVED_SEGMENTS.has(segments[1])
  ) {
    return true;
  }
  return false;
}

function isApiRoute(path) {
  return (
    path.startsWith('/invoices') ||
    path.startsWith('/chat') ||
    path.startsWith('/profile') ||
    path.startsWith('/transfers') ||
    path === '/banks' ||
    path.startsWith('/earnings') ||
    path.startsWith('/community') ||
    path.startsWith('/checkout') ||
    path === '/health' ||
    path === '/config' ||
    path.startsWith('/webhooks') ||
    path === '/ussd' ||
    path.startsWith('/ussd/')
  );
}

function isCheckoutPublicPath(path, method) {
  if (path.startsWith('/data/')) return true;
  if (method === 'GET' && /^\/api\/[^/]+\/[^/]+$/.test(path)) return true;
  if (method === 'GET' && isCheckoutProductPath(path)) return true;
  if (method === 'POST' && /^\/[^/]+\/pay$/.test(path)) return true;
  if (method === 'GET' && (path.startsWith('/download/') || path.startsWith('/checkout/download/'))) {
    return true;
  }
  return false;
}

function serveCheckoutHtml(req, res, next) {
  res.sendFile(checkoutHtmlPath, (err) => {
    if (err) {
      console.error('[Checkout] sendFile failed:', err.message);
      next(err);
    }
  });
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

const ALLOWED_ORIGINS = [
  'https://payoapp.org',
  'https://www.payoapp.org',
  'https://payo-production.up.railway.app',
  'http://localhost:3000',
];

app.use(
  cors({
    origin: function (origin, callback) {
      // No Origin header = same-origin request, curl, webhook, or mobile app
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use('/webhooks/paystack', express.raw({ type: 'application/json' }));
app.use('/webhooks/nowpayments', express.raw({ type: 'application/json' }));
// Chat sends conversation history, which can outgrow 10kb — give it more room
app.use('/chat', express.json({ limit: '50kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(generalLimiter);

// Checkout HTML — must be registered before app.use('/checkout') API mount
app.get('/checkout/:username/:slug', serveCheckoutHtml);

app.get('/health', (req, res) => {
  res.json({ status: 'Payo is alive' });
});

app.get('/config', (req, res) => {
  res.json({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '' });
});

app.get('/banks', transfersLimiter, async (req, res) => {
  try {
    const banks = await getBanks();
    res.json({ success: true, banks });
  } catch (err) {
    console.error('[Banks] List failed:', err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to load banks',
    });
  }
});

app.use('/checkout', checkoutLimiter, (req, res, next) => {
  if (isCheckoutPublicPath(req.path, req.method)) {
    return next();
  }
  return clerkRequireAuth(req, res, next);
}, checkoutRoutes);

// Protected API routes — Clerk auth applied per mount, before static
app.use('/invoices', invoicesLimiter, clerkRequireAuth, invoiceRoutes);
app.use('/webhooks/paystack', webhookRoutes);
app.use('/webhooks/nowpayments', nowpaymentsWebhookRoutes);
app.use('/chat', chatLimiter, clerkRequireAuth, chatRoutes);
app.use('/profile', profileLimiter, (req, res, next) => {
  if (req.method === 'GET' && req.path === '/verify-bank') {
    return next();
  }
  return clerkRequireAuth(req, res, next);
}, profileRoutes);
app.use('/earnings', profileLimiter, clerkRequireAuth, earningsRoutes);
app.use('/transfers', transfersLimiter, clerkRequireAuth, transferRoutes);
app.use('/community', communityLimiter, (req, res, next) => {
  if (req.method === 'GET' && req.path === '/feed') {
    return next();
  }
  return clerkRequireAuth(req, res, next);
}, communityRoutes);

app.use('/ussd', ussdRoutes);

// Static files only for non-API paths (never intercept /profile, /chat, etc.)
app.use((req, res, next) => {
  if (isApiRoute(req.path)) {
    return next();
  }
  serveStatic(req, res, next);
});

// JSON 404 for unmatched API routes
app.use((req, res, next) => {
  if (isApiRoute(req.path) && !isPublicRoute(req.path)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  next();
});

// Fallback: serve checkout page for product URLs that slipped through
app.get(/^\/checkout\/[^/]+\/[^/]+$/, serveCheckoutHtml);

app.use((err, req, res, next) => {
  if (err.message === 'Unauthenticated') {
    return res.status(401).json({ success: false, error: 'Unauthenticated' });
  }
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, error: 'Not allowed by CORS' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Payo server running on port ${PORT}`);
});

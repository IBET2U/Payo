const Sentry = require('@sentry/node');
Sentry.init({ 
  dsn: 'https://20572c681aea863a65f724d04d764512@o4511527778779136.ingest.us.sentry.io/4511527788085248',
  tracesSampleRate: 1.0
});
require('dotenv').config();
const express = require('express');
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

const clerkRequireAuth = ClerkExpressRequireAuth();
const publicDir = path.join(__dirname, 'public');
const serveStatic = express.static(publicDir);

const PUBLIC_PATHS = new Set(['/health', '/config', '/ussd', '/banks']);

function isPublicRoute(path) {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith('/webhooks/paystack')) return true;
  if (path.startsWith('/ussd/')) return true;
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
    path === '/health' ||
    path === '/config' ||
    path.startsWith('/webhooks') ||
    path === '/ussd' ||
    path.startsWith('/ussd/')
  );
}

app.use(cors());
app.use('/webhooks/paystack', express.raw({ type: 'application/json' }));
app.use('/webhooks/nowpayments', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(generalLimiter);

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

// Protected API routes — Clerk auth applied per mount, before static
app.use('/invoices', invoicesLimiter, clerkRequireAuth, invoiceRoutes);
app.use('/webhooks/paystack', webhookRoutes);
app.use('/webhooks/nowpayments', nowpaymentsWebhookRoutes);
app.use('/chat', chatLimiter, clerkRequireAuth, chatRoutes);
app.use('/profile', profileLimiter, clerkRequireAuth, profileRoutes);
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

app.use((err, req, res, next) => {
  if (err.message === 'Unauthenticated') {
    return res.status(401).json({ success: false, error: 'Unauthenticated' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Payo server running on port ${PORT}`);
});

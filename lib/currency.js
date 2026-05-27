function normalizeCurrency(currency) {
  // Only explicit USD uses dollar payments; everything else is Naira (Payo default)
  if (String(currency || '').toUpperCase().trim() === 'USD') {
    return 'USD';
  }
  return 'NGN';
}

function formatAmountForCurrency(amount, currency) {
  const code = normalizeCurrency(currency);
  const num = Number(amount);
  const formattedAmount = Number.isFinite(num)
    ? num.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : String(amount);

  if (code === 'USD') {
    return {
      code: 'USD',
      symbol: '$',
      currencyName: 'US Dollars',
      formattedAmount,
      display: `$${formattedAmount}`,
      invoiceType: 'international',
    };
  }

  return {
    code: 'NGN',
    symbol: '₦',
    currencyName: 'Nigerian Naira',
    formattedAmount,
    display: `₦${formattedAmount}`,
    invoiceType: 'local Nigerian',
  };
}

const NGN_PATTERN = /₦|\bnaira\b|\bngn\b/i;
/** $ before digits (e.g. $500), or explicit USD / dollar words — not bare $ end-anchor mistakes */
const USD_PATTERN = /\$\s*[\d,]|\busd\b|\bdollars?\b|\bdollar\b/i;

function textHasNgn(text) {
  return NGN_PATTERN.test(text);
}

function textHasUsd(text) {
  return USD_PATTERN.test(text);
}

/**
 * Infer currency from a single message. Returns 'USD', 'NGN', or null if ambiguous.
 */
function inferCurrencyFromText(text) {
  if (!text || !String(text).trim()) {
    const result = null;
    console.log('[INFER DEBUG] text:', text, 'result:', result);
    return result;
  }

  const raw = String(text);
  const hasNgn = textHasNgn(raw);
  const hasUsd = textHasUsd(raw);

  let result = null;

  if (hasNgn && !hasUsd) {
    result = 'NGN';
  } else if (hasUsd && !hasNgn) {
    result = 'USD';
  } else if (hasNgn && hasUsd) {
    const ngnMatch = raw.search(/₦\s*[\d,]/);
    const usdMatch = raw.search(/\$\s*[\d,]/);
    if (usdMatch >= 0 && (ngnMatch < 0 || usdMatch > ngnMatch)) {
      result = 'USD';
    } else if (ngnMatch >= 0) {
      result = 'NGN';
    }
  }

  console.log('[INFER DEBUG] text:', text, 'result:', result);
  return result;
}

/**
 * Resolve invoice currency: latest user message first, then Claude extraction, then history.
 * Default: NGN (Payo is for Nigerian freelancers).
 */
function resolveCurrency(extracted, userMessage, conversationMessages = []) {
  const fromLatest = inferCurrencyFromText(userMessage);
  if (fromLatest) return fromLatest;

  const fromExtracted = extracted?.currency
    ? normalizeCurrency(extracted.currency)
    : null;
  if (fromExtracted === 'USD' || fromExtracted === 'NGN') {
    return fromExtracted;
  }

  const historyUserMessages = conversationMessages
    .filter((m) => m.role === 'user')
    .map((m) => m.content || '');

  for (let i = historyUserMessages.length - 1; i >= 0; i--) {
    const fromHistory = inferCurrencyFromText(historyUserMessages[i]);
    if (fromHistory) return fromHistory;
  }

  return 'NGN';
}

/** @deprecated Use resolveCurrency */
function resolveInvoiceCurrency(extracted, userMessage, conversationMessages = []) {
  return resolveCurrency(extracted, userMessage, conversationMessages);
}

function enforceCurrencyInInvoiceBody(text, currency, amount) {
  const normalized = normalizeCurrency(currency);
  const { display } = formatAmountForCurrency(amount, normalized);
  let body = text;

  if (normalized === 'NGN') {
    body = body.replace(/\$\s*([\d,]+(?:\.\d{1,2})?)/g, display);
    body = body.replace(/\bUSD\b/gi, 'NGN');
    body = body.replace(/\bUS\s*dollars?\b/gi, 'Nigerian Naira');
    body = body.replace(/\bdollars?\b/gi, 'Naira');
  } else {
    body = body.replace(/₦\s*([\d,]+(?:\.\d{1,2})?)/g, display);
    body = body.replace(/\bNGN\b/gi, 'USD');
    body = body.replace(/\bNigerian\s*Naira\b/gi, 'US Dollars');
    body = body.replace(/\bnaira\b/gi, 'dollars');
  }

  return body;
}

function buildNgnInvoiceEmail(clientName, projectDescription, display, dueDate) {
  return `Dear ${clientName},

Thank you for the opportunity to work with you.

**Services rendered**
${projectDescription}

**Amount due:** ${display} (Nigerian Naira)
**Payment due date:** ${dueDate}

Please use the Pay Now button in this email to complete your payment securely via Paystack in Naira.

If you have any questions about this invoice, simply reply to this email.

Warm regards,
The Payo Team
(on behalf of your freelancer)`;
}

module.exports = {
  normalizeCurrency,
  formatAmountForCurrency,
  inferCurrencyFromText,
  resolveCurrency,
  resolveInvoiceCurrency,
  enforceCurrencyInInvoiceBody,
  buildNgnInvoiceEmail,
  textHasNgn,
  textHasUsd,
};

const Anthropic = require('@anthropic-ai/sdk');
const {
  normalizeCurrency,
  formatAmountForCurrency,
  enforceCurrencyInInvoiceBody,
  buildNgnInvoiceEmail,
  inferCurrencyFromText,
} = require('./lib/currency');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function generateInvoice(
  projectDescription,
  clientName,
  amount,
  dueDate,
  currency
) {
  console.log('[CLAUDE DEBUG] generateInvoice called with currency:', currency, 'normalized:', normalizeCurrency(currency));
  const normalizedCurrency = normalizeCurrency(currency);
  const { symbol, currencyName, formattedAmount, display, invoiceType } =
    formatAmountForCurrency(amount, normalizedCurrency);

  // NGN: deterministic template — never call Claude (it often writes $ anyway)
  if (normalizedCurrency === 'NGN') {
    return buildNgnInvoiceEmail(clientName, projectDescription, display, dueDate);
  }

  const systemPrompt = `You write invoice emails in US Dollars (USD) ONLY. Use the $ symbol for every amount. Never use ₦, NGN, or the word "naira".`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Generate an invoice for ${clientName} for the amount of ${symbol}${formattedAmount} ${currencyName}.
YOU MUST USE ${symbol} EVERYWHERE THE AMOUNT IS MENTIONED.
DO NOT USE ANY OTHER CURRENCY SYMBOL.
This is a ${invoiceType} invoice.

Client Name: ${clientName}
Project: ${projectDescription}
Amount (exact): ${display}
Currency: ${currencyName} (${normalizedCurrency})
Due Date: ${dueDate}

Write a complete professional invoice email. Signed as "The Payo Team" on behalf of the freelancer.`,
      },
    ],
  });

  const raw = message.content[0].text;
  return enforceCurrencyInInvoiceBody(raw, normalizedCurrency, amount);
}

async function generateFollowUp(clientName, amount, dueDate, daysPastDue, previousAttempts) {
  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `You are Payo, a professional financial agent. Generate a follow-up payment reminder email.

Client Name: ${clientName}
Amount Owed: $${amount}
Original Due Date: ${dueDate}
Days Past Due: ${daysPastDue}
Previous Follow-up Attempts: ${previousAttempts}

Rules:
- Attempt 1 (days 1-3): Friendly and assumptive. Assume they just forgot.
- Attempt 2 (days 4-7): Polite but firm. Reference previous reminder.
- Attempt 3 (days 8-14): Professional and direct. Request confirmation of payment date.
- Never be rude or aggressive.
- Never mention crypto or blockchain.
- Keep it short — 3-4 sentences maximum.
- Sign as "The Payo Team"`,
      },
    ],
  });

  return message.content[0].text;
}

async function parseChatIntent(userMessage, conversationHistory = []) {
  const historyMessages = conversationHistory.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    system: `You are Payo, a friendly AI payment agent for Nigerian freelancers. Analyze the conversation and latest message.

Determine intent:
- "create_invoice" — user wants to create/send an invoice
- "unclear" — intent is ambiguous or missing required invoice details
- "general" — greeting, question, or other chat

For create_invoice, extract any mentioned fields (use null if missing):
client_name, client_email, client_phone, amount (number only, no currency symbols), due_date (YYYY-MM-DD if possible), project_description, currency

client_phone — Extract any phone number mentioned in the message:
- Accept ANY format from ANY country, including: +14434700063, +2348012345678, 08012345678, 2348012345678, +44 20 7946 0958, (212) 555-0143
- If a number starts with "+" followed by digits — that IS a phone number. Extract it. Do not skip it because the country code is not Nigerian.
- Phone numbers commonly appear after the word "at", right after an email address, or standalone in the message
- Return the phone number EXACTLY as written, including the leading "+" sign and any spaces, dashes, or parentheses the user typed. Do not invent digits, do not reformat, do not strip the "+"
- If a message contains both an email and a phone, extract BOTH — they are separate fields
- If no phone number is present, return null
- Examples:
  - "Invoice Test Client at dndsent@gmail.com +14434700063 ₦150,000 for logo design due June 30" → client_name="Test Client", client_email="dndsent@gmail.com", client_phone="+14434700063", amount=150000, currency="NGN", project_description="logo design", due_date="<this year>-06-30"
  - "Invoice Chidi +2348012345678 ₦150,000 for design due June 30" → client_name="Chidi", client_phone="+2348012345678", amount=150000, currency="NGN", project_description="design", due_date="<this year>-06-30"
  - "Invoice Tunde 08012345678 for ₦50,000 website work due July 1" → client_name="Tunde", client_phone="08012345678", amount=50000, currency="NGN", project_description="website work", due_date="<this year>-07-01"

Currency detection (required before creating an invoice):
- Set "USD" whenever the latest message includes a dollar amount like $500, $1,000, or the words "dollar", "dollars", or "USD" (a $ before digits always means USD)
- Set "NGN" when the message uses ₦, "naira", or "NGN" (e.g. ₦150,000)
- null only if the amount has no currency symbol or keyword — ask: "Is that in dollars or naira?"
- DEFAULT to "NGN" when ambiguous and no dollar sign (Payo is for Nigerian freelancers)
- Never set USD without $ or dollar/USD wording; never set NGN when the amount is clearly in dollars

Required for create_invoice: client_name, amount, due_date, project_description, currency, AND at least one of client_email or client_phone (both are individually optional but at least one contact method must be present).

Respond with ONLY valid JSON, no markdown:
{
  "intent": "create_invoice" | "unclear" | "general",
  "extracted": {
    "client_name": string | null,
    "client_email": string | null,
    "client_phone": string | null,
    "amount": number | null,
    "due_date": string | null,
    "project_description": string | null,
    "currency": "USD" | "NGN" | null
  },
  "reply": "Natural conversational response. If create_invoice but fields missing (including currency, or both client_email and client_phone are missing), ask warmly for what's missing. If only one of email/phone is missing, that's fine — do not ask. If currency is unclear, ask whether it is dollars or naira. When confirming a created invoice, use ₦ for NGN and $ for USD. Keep under 3 sentences unless listing missing fields."
}`,
    messages: [
      ...historyMessages,
      { role: 'user', content: userMessage },
    ],
  });

  const text = message.content[0].text.trim();
  console.log('[CLAUDE PARSE] raw response:', text);

  const safeDefault = {
    intent: 'general',
    extracted: {},
    reply: 'Sorry, e do small. Try again.',
  };

  const jsonMatches = text.match(/\{[\s\S]*\}/g);
  if (!jsonMatches || jsonMatches.length === 0) {
    console.error('[CLAUDE PARSE] No JSON object found in response');
    return safeDefault;
  }

  const jsonStr = jsonMatches[jsonMatches.length - 1];

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    console.error('[CLAUDE PARSE] JSON.parse failed:', err.message, 'candidate:', jsonStr);
    return safeDefault;
  }

  if (!parsed || typeof parsed !== 'object') {
    return safeDefault;
  }

  if (!parsed.intent) {
    parsed.intent = 'general';
  }
  if (!parsed.extracted || typeof parsed.extracted !== 'object') {
    parsed.extracted = {};
  }
  if (!parsed.reply) {
    parsed.reply = safeDefault.reply;
  }

  if (parsed.extracted) {
    const inferred = inferCurrencyFromText(userMessage);
    if (inferred) {
      parsed.extracted.currency = inferred;
    }
  }

  return parsed;
}

module.exports = { generateInvoice, generateFollowUp, parseChatIntent };

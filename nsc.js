const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const MAX_KB_CHARS = 100000;

function loadNscContent() {
  const contentPaths = [
    path.join(__dirname, 'nsc content.txt'),
    path.join(__dirname, 'nsc-content.txt'),
  ];
  for (const contentPath of contentPaths) {
    try {
      return fs.readFileSync(contentPath, 'utf8');
    } catch (err) {
      /* try next path */
    }
  }
  return 'NSC is the Nigerian Shippers Council, a federal government agency that regulates shipping and freight in Nigeria.';
}

function prepareKnowledgeBase(raw) {
  let text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\t+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length > MAX_KB_CHARS) {
    text = text.slice(0, MAX_KB_CHARS) + '\n\n[Additional NSC reference material omitted for length.]';
  }
  return text;
}

const nscContent = prepareKnowledgeBase(loadNscContent());

const NSC_SYSTEM_PROMPT = `You are the official AI Assistant for the Nigerian Shippers Council (NSC) — a federal government agency that regulates shipping and freight transportation in Nigeria.

Your role is to help freight forwarders, shipping companies, importers, exporters, and port agents get accurate information about NSC services, procedures, and regulations instantly — 24 hours a day, 7 days a week.

RULES:
- Only answer questions related to NSC, shipping, freight forwarding, port procedures, and maritime topics
- Be professional, clear, and helpful
- Keep answers concise — under 150 words unless complex question requires more
- If you don't know something specific say: "For specific details on this, please contact NSC directly at info@nscinigeria.gov.ng or nsc@shipperscouncil.gov.ng"
- Never make up fees, charges, or procedures you are not sure about
- Always sound like an official government representative

NSC KNOWLEDGE BASE:
${nscContent}`;

async function askNSC(question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 500,
    system: NSC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: question }],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('No text response from model');
  }
  return textBlock.text;
}

module.exports = { askNSC };

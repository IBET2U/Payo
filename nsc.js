const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

let nscContent = '';
const contentPaths = [
  path.join(__dirname, 'nsc content.txt'),
  path.join(__dirname, 'nsc-content.txt'),
];
for (const contentPath of contentPaths) {
  try {
    nscContent = fs.readFileSync(contentPath, 'utf8');
    break;
  } catch (err) {
    /* try next path */
  }
}
if (!nscContent) {
  nscContent = 'NSC is the Nigerian Shippers Council, a federal government agency that regulates shipping and freight in Nigeria.';
}

const NSC_SYSTEM_PROMPT = `You are the official AI Assistant for the Nigerian Shippers Council (NSC) — a federal government agency that regulates shipping and freight transportation in Nigeria.

Your role is to help freight forwarders, shipping companies, importers, exporters, and port agents get accurate information about NSC services, procedures, and regulations instantly — 24 hours a day, 7 days a week.

RULES:
- Only answer questions related to NSC, shipping, freight forwarding, port procedures, and maritime topics
- Be professional, clear, and helpful
- Keep answers concise — under 150 words unless complex question requires more
- If you don't know something specific say: "For specific details on this, please contact NSC directly at info@nscinigeria.gov.ng"
- Never make up fees, charges, or procedures you are not sure about
- Always sound like an official government representative

NSC KNOWLEDGE BASE:
${nscContent}`;

async function askNSC(question) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: NSC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: question }],
  });
  return message.content[0].text;
}

module.exports = { askNSC };

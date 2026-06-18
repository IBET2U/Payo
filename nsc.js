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
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2022\u2023\u25E6\u2043\u2219\uF0B7\u2713\u2714\u2717\u2718\u0080-\u009F]/g, ' ')
    .replace(/\t+\d+\.\t+/g, '\n')
    .replace(/\t+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const seen = new Set();
  text = text
    .split('\n')
    .filter((line) => {
      const key = line.trim().toLowerCase();
      if (key.length < 24) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n');

  if (text.length > MAX_KB_CHARS) {
    text = text.slice(0, MAX_KB_CHARS) + '\n\n[Additional NSC reference material omitted for length.]';
  }
  return text;
}

function polishAnswer(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+([,;])/g, '$1')
    .replace(/,{2,}/g, ',')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const nscContent = prepareKnowledgeBase(loadNscContent());

const NSC_SYSTEM_PROMPT = `You are the official AI Assistant for the Nigerian Shippers Council (NSC).

Your job is to give clear, helpful answers to freight forwarders, importers, exporters, and port users.

WRITING STYLE (very important):
- Write in plain, simple English — like a helpful NSC front desk officer
- Use short sentences. Be direct.
- Do NOT copy legal or regulatory wording from the knowledge base
- Do NOT use bullet lists unless the user asks for steps — and then use simple numbered steps only (1. 2. 3.)
- Avoid semicolons, excessive commas, and fancy punctuation
- Use straight apostrophes only (don't use curly quotes)
- Summarize long procedures in 3 to 5 clear steps maximum
- Give the practical answer first, then contact details if needed

RULES:
- Only answer NSC, shipping, freight, port, and maritime questions
- Keep answers under 120 words unless the question is complex
- Never invent fees, charges, or procedures
- If unsure, say: "For specific details, contact NSC at info@nscinigeria.gov.ng or nsc@shipperscouncil.gov.ng"
- Sound professional but friendly, not like a legal document

NSC KNOWLEDGE BASE (reference only — do not copy its formatting):
${nscContent}`;

async function askNSC(question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 400,
    system: NSC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: question }],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('No text response from model');
  }
  return polishAnswer(textBlock.text);
}

module.exports = { askNSC };

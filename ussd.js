const AfricasTalking = require('africastalking');
const supabase = require('./supabase');
const { normalizeNigerianPhone } = require('./whatsapp');

const AT_USERNAME = process.env.AT_USERNAME || 'sandbox';
const AT_API_KEY = process.env.AT_API_KEY;
const AT_SMS_FROM = process.env.AT_SMS_FROM;
const PAYO_BASE_URL = (process.env.PAYO_BASE_URL || 'https://payoapp.org').replace(/\/+$/, '');

let smsClient = null;
if (AT_API_KEY && AT_USERNAME) {
  try {
    const at = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
    smsClient = at.SMS;
  } catch (err) {
    console.error('[USSD ERROR] Failed to initialize Africa\'s Talking client:', err.message);
  }
} else {
  console.error('[USSD ERROR] Missing AT_API_KEY or AT_USERNAME — SMS sending disabled');
}

function formatNaira(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return String(amount);
  return num.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPaidDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

async function sendSms(toPhone, message, label) {
  if (!smsClient) {
    console.error(`[USSD ERROR] ${label}: SMS client not configured, skipping send to ${toPhone}`);
    return null;
  }

  const normalized = normalizeNigerianPhone(toPhone);
  if (!normalized) {
    console.error(`[USSD ERROR] ${label}: invalid phone number "${toPhone}"`);
    return null;
  }

  try {
    const payload = { to: [normalized], message };
    if (AT_SMS_FROM) payload.from = AT_SMS_FROM;

    const result = await smsClient.send(payload);
    console.log(`[USSD] ${label}: SMS sent to ${normalized}`);
    return result;
  } catch (err) {
    console.error(`[USSD ERROR] ${label}: failed to send SMS to ${normalized} —`, err.message);
    return null;
  }
}

async function createUssdInvoice({ freelancerPhone, clientPhone, amount, description }) {
  const { data, error } = await supabase
  .from('invoices')
  .insert({
    freelancer_id: freelancerPhone,
    freelancer_phone: freelancerPhone,
    client_name: clientPhone,  // ← ADD THIS
    client_phone: clientPhone,
    amount,
    project_description: description,
    currency: 'NGN',
    status: 'unpaid',
    source: 'ussd',
  })
    .select()
    .single();

  if (error) {
    console.error('[USSD ERROR] Failed to create invoice:', error.message);
    return null;
  }

  console.log(`[USSD] Invoice created: ${data.id} (freelancer ${freelancerPhone} → client ${clientPhone})`);
  return data;
}

async function findLatestInvoice(freelancerPhone, clientPhone) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('freelancer_id', freelancerPhone)
    .eq('client_phone', clientPhone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[USSD ERROR] Failed to query invoice:', error.message);
    return null;
  }
  return data;
}

/**
 * Parse the USSD `text` field into navigation steps.
 * Each user input is pipe-separated, so we split on `|`.
 */
function parseSteps(text) {
  if (!text || text === '') return [];
  return String(text).split('|');
}

/**
 * Core USSD state machine.
 * Returns a string starting with "CON " (continue) or "END " (terminate).
 *
 * Menu structure:
 *   1 → Create Invoice → phone → amount → description → confirm (1 send / 2 cancel)
 *   2 → Check Status → phone → result
 *   3 → Exit
 */
async function handleUssdRequest({ sessionId, serviceCode, phoneNumber, text }) {
  const steps = parseSteps(text);
  const dialingPhone = phoneNumber;

  console.log(
    `[USSD] session=${sessionId} service=${serviceCode} phone=${phoneNumber} text="${text}" steps=${JSON.stringify(steps)}`
  );

  if (steps.length === 0) {
    return `CON Welcome to Payo 💚
1. Create Invoice
2. Check Payment Status
3. Exit`;
  }

  const choice = steps[0];

  if (choice === '1') {
    return handleCreateInvoiceFlow(steps, dialingPhone);
  }

  if (choice === '2') {
    return handleStatusCheckFlow(steps, dialingPhone);
  }

  if (choice === '3') {
    return `END Thank you for using Payo! 💚
Get paid faster at payoapp.org`;
  }

  return `END Invalid option.
Please dial again and choose 1, 2, or 3.`;
}

async function handleCreateInvoiceFlow(steps, dialingPhone) {
  if (steps.length === 1) {
    return `CON Enter client phone number:
(Nigerian format e.g. 08012345678)`;
  }

  const rawClientPhone = steps[1];
  const normalizedClient = normalizeNigerianPhone(rawClientPhone);

  if (!normalizedClient) {
    return `END Invalid phone number.
Please dial again and use a Nigerian
format like 08012345678.`;
  }

  if (steps.length === 2) {
    return `CON Enter amount in Naira:
(numbers only e.g. 50000)`;
  }

  const rawAmount = steps[2];
  const amount = Number(String(rawAmount).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) {
    return `END Invalid amount.
Please dial again and enter a number
like 50000.`;
  }

  if (steps.length === 3) {
    return `CON Enter job description:
(e.g. plumbing work, logo design)`;
  }

  const description = String(steps[3] || '').trim();
  if (!description) {
    return `END Description cannot be empty.
Please dial again and describe the job.`;
  }

  if (steps.length === 4) {
    return `CON Confirm invoice details:
Client: ${normalizedClient}
Amount: ₦${formatNaira(amount)}
Job: ${description}

1. Send Invoice
2. Cancel`;
  }

  const confirm = steps[4];

  if (confirm === '2') {
    return `END Invoice cancelled.
Dial again when ready.`;
  }

  if (confirm !== '1') {
    return `END Invalid choice.
Please dial again to retry.`;
  }

  const invoice = await createUssdInvoice({
    freelancerPhone: dialingPhone,
    clientPhone: normalizedClient,
    amount,
    description,
  });

  if (!invoice) {
    return `END Sorry, we couldn't create your
invoice right now. Please try again
in a moment.`;
  }

  const paymentLink = `${PAYO_BASE_URL}/pay/${invoice.id}`;

  await sendSms(
    normalizedClient,
    `Hello! New invoice from ${dialingPhone}: ₦${formatNaira(amount)} for ${description}. Pay: ${paymentLink}`,
    'Client invoice SMS'
  );

  await sendSms(
    dialingPhone,
    `Invoice sent to ${normalizedClient} for ₦${formatNaira(amount)}. We'll notify you when they pay.`,
    'Freelancer confirmation SMS'
  );

  return `END Invoice sent! ✅
Your client will receive a payment link via SMS.
Thank you for using Payo.`;
}

async function handleStatusCheckFlow(steps, dialingPhone) {
  if (steps.length === 1) {
    return `CON Enter the client phone number
you invoiced:`;
  }

  const rawClientPhone = steps[1];
  const normalizedClient = normalizeNigerianPhone(rawClientPhone);

  if (!normalizedClient) {
    return `END Invalid phone number.
Please dial again and use a Nigerian
format like 08012345678.`;
  }

  const invoice = await findLatestInvoice(dialingPhone, normalizedClient);

  if (!invoice) {
    return `END No invoice found for
${normalizedClient}. Create one by
dialing again and pressing 1.`;
  }

  if (invoice.status === 'paid') {
    return `END ✅ Payment received!
${normalizedClient} paid ₦${formatNaira(invoice.amount)}
on ${formatPaidDate(invoice.paid_at || invoice.updated_at || invoice.created_at)}.`;
  }

  return `END ⏳ Payment pending.
Invoice for ₦${formatNaira(invoice.amount)} sent to
${normalizedClient} is still unpaid.`;
}

module.exports = {
  handleUssdRequest,
  parseSteps,
  sendSms,
  createUssdInvoice,
  findLatestInvoice,
};

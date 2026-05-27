require('dotenv').config();
const cron = require('node-cron');
const supabase = require('./supabase');
const { generateFollowUp } = require('./claude');
const { sendFollowUpEmail } = require('./mailer');
const { sendFollowUpWhatsApp } = require('./whatsapp');

const TIMEZONE = process.env.TZ || 'Africa/Lagos';

function getDaysPastDue(dueDate) {
  const due = new Date(dueDate);
  const now = new Date();
  if (now <= due) return 0;

  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.floor((now - due) / msPerDay);
}

function getDateKey(date, timeZone = TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function wasFollowUpSentToday(lastFollowUpSent) {
  if (!lastFollowUpSent) return false;
  return getDateKey(new Date(lastFollowUpSent)) === getDateKey(new Date());
}

function getFollowUpConfig(daysPastDue) {
  if (daysPastDue >= 3 && daysPastDue <= 6) {
    return { attempt: 1, previousAttempts: 0 };
  }
  if (daysPastDue >= 7 && daysPastDue <= 13) {
    return { attempt: 2, previousAttempts: 1 };
  }
  if (daysPastDue >= 14) {
    return { attempt: 3, previousAttempts: 2 };
  }
  return null;
}

async function processUnpaidInvoices() {
  console.log('[Payo Follow-up] Starting daily follow-up job...');

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('status', 'unpaid');

  if (error) {
    console.error('[Payo Follow-up] Failed to fetch unpaid invoices:', error.message);
    return;
  }

  console.log(`[Payo Follow-up] Found ${invoices.length} unpaid invoice(s)`);

  for (const invoice of invoices) {
    const daysPastDue = getDaysPastDue(invoice.due_date);
    const config = getFollowUpConfig(daysPastDue);

    console.log(
      `[Payo Follow-up] Invoice ${invoice.id} — ${invoice.client_name}: ${daysPastDue} day(s) past due`
    );

    if (!config) {
      console.log(`[Payo Follow-up] Invoice ${invoice.id}: not in follow-up window, skipping`);
      continue;
    }

    if (wasFollowUpSentToday(invoice.last_follow_up_sent)) {
      console.log(
        `[Payo Follow-up] Invoice ${invoice.id}: follow-up already sent today, skipping`
      );
      continue;
    }

    try {
      console.log(
        `[Payo Follow-up] Invoice ${invoice.id}: sending attempt ${config.attempt} follow-up`
      );

      let emailSent = false;
      if (invoice.client_email) {
        try {
          const followUpContent = await generateFollowUp(
            invoice.client_name,
            invoice.amount,
            invoice.due_date,
            daysPastDue,
            config.previousAttempts
          );

          await sendFollowUpEmail(
            invoice.client_email,
            invoice.client_name,
            followUpContent,
            invoice.amount,
            invoice.due_date,
            invoice.currency || 'NGN'
          );
          emailSent = true;
        } catch (emailErr) {
          console.error(
            `[Payo Follow-up] Invoice ${invoice.id}: email follow-up failed —`,
            emailErr.message
          );
        }
      } else {
        console.log(
          `[Payo Follow-up] Invoice ${invoice.id}: no client_email, skipping email follow-up`
        );
      }

      let whatsAppSent = false;
      if (invoice.client_phone) {
        try {
          const result = await sendFollowUpWhatsApp(
            invoice.client_phone,
            invoice.client_name,
            invoice.freelancer_name || 'Your Freelancer',
            invoice.amount,
            invoice.currency || 'NGN',
            daysPastDue,
            invoice.payment_url
          );
          whatsAppSent = !!result;
        } catch (waErr) {
          console.error(
            `[Payo Follow-up] Invoice ${invoice.id}: WhatsApp follow-up failed —`,
            waErr.message
          );
        }
      }

      if (!emailSent && !whatsAppSent) {
        console.warn(
          `[Payo Follow-up] Invoice ${invoice.id}: no follow-up channels succeeded; not updating timestamps`
        );
        continue;
      }

      const sentAt = new Date().toISOString();
      const followUpCount = (invoice.follow_up_count ?? 0) + 1;

      const { error: updateError } = await supabase
        .from('invoices')
        .update({
          last_follow_up_sent: sentAt,
          follow_up_count: followUpCount,
        })
        .eq('id', invoice.id);

      if (updateError) throw updateError;

      console.log(
        `[Payo Follow-up] Invoice ${invoice.id}: attempt ${config.attempt} sent (email=${emailSent}, whatsapp=${whatsAppSent}, follow_up_count=${followUpCount})`
      );
    } catch (err) {
      console.error(
        `[Payo Follow-up] Invoice ${invoice.id}: failed to send follow-up —`,
        err.message
      );
    }
  }

  console.log('[Payo Follow-up] Daily follow-up job complete');
}

cron.schedule('0 9 * * *', processUnpaidInvoices, {
  timezone: TIMEZONE,
});

console.log(`[Payo Follow-up] Scheduled daily at 9:00 AM (${TIMEZONE})`);

module.exports = {
  processUnpaidInvoices,
  getDaysPastDue,
  getFollowUpConfig,
  wasFollowUpSentToday,
};

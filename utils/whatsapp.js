const WHATSAPP_API_URL = 'https://graph.facebook.com/v19.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Format a date to DD/MM/YYYY
const formatDate = (date) => {
  const d = new Date(date);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// Format time to HH:MM AM/PM
const formatTime = (date) => {
  const d = new Date(date);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
};

// Core send function
const sendWhatsAppTemplate = async ({ to, templateName, variables }) => {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.warn('WhatsApp not configured — skipping message to:', to);
    return;
  }

  // Normalize number — strip spaces, ensure + prefix
  const phone = to.replace(/\s/g, '').replace(/^\+?/, '+');

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: variables.map((v) => ({ type: 'text', text: String(v) })),
        },
      ],
    },
  };

  const res = await fetch(`${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (data.error) {
    console.error(`WhatsApp send failed (${templateName} → ${phone}):`, data.error.message);
    throw new Error(data.error.message);
  }

  console.log(`WhatsApp sent: ${templateName} → ${phone}`);
  return data;
};

// ── NOTIFICATION HELPERS ──────────────────────────────────────────────────────

// task_reminder — Hi {{1}}, you have a task due soon: *{{2}}*. Due: {{3}} at {{4}}.
const sendTaskReminder = async ({ phone, name, taskTitle, dueDate }) => {
  return sendWhatsAppTemplate({
    to: phone,
    templateName: 'task_reminder',
    variables: [name, taskTitle, formatDate(dueDate), formatTime(dueDate)],
  });
};

// task_assigned — Hi {{1}}, you have been assigned a new task: *{{2}}*. Due: {{3}} at {{4}}.
const sendTaskAssigned = async ({ phone, name, taskTitle, dueDate }) => {
  return sendWhatsAppTemplate({
    to: phone,
    templateName: 'task_assigned',
    variables: [name, taskTitle, formatDate(dueDate), formatTime(dueDate)],
  });
};

// deal_assigned — Hi {{1}}, a new deal has been assigned to you: *{{2}}*.
const sendDealAssigned = async ({ phone, name, dealTitle }) => {
  return sendWhatsAppTemplate({
    to: phone,
    templateName: 'deal_assigned',
    variables: [name, dealTitle],
  });
};

// deal_inactive — Hi {{1}}, the deal *{{2}}* has had no activity for {{3}} days.
const sendDealInactive = async ({ phone, name, dealTitle, days }) => {
  return sendWhatsAppTemplate({
    to: phone,
    templateName: 'deal_inactive',
    variables: [name, dealTitle, days],
  });
};

module.exports = {
  sendWhatsAppTemplate,
  sendTaskReminder,
  sendTaskAssigned,
  sendDealAssigned,
  sendDealInactive,
};
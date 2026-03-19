const nodemailer = require('nodemailer');

const getTransporter = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const baseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { margin: 0; padding: 0; background: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e5e7eb; }
    .header { background: #1e2336; padding: 28px 40px; }
    .header h1 { margin: 0; color: #ffffff; font-size: 20px; font-weight: 600; }
    .header p { margin: 4px 0 0; color: #8b92a5; font-size: 13px; }
    .body { padding: 36px 40px; }
    .body p { color: #374151; font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
    .body p.muted { color: #6b7280; font-size: 13px; }
    .btn { display: inline-block; background: #5046e4; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600; margin: 8px 0 24px; }
    .divider { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
    .footer { padding: 20px 40px; background: #f9fafb; border-top: 1px solid #e5e7eb; }
    .footer p { margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.5; }
    .url-fallback { word-break: break-all; color: #5046e4; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>${process.env.APP_NAME || 'CRM'}</h1>
      <p>Business made simple</p>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      <p>This email was sent by ${process.env.APP_NAME || 'CRM'}. If you didn't request this, you can safely ignore it.</p>
    </div>
  </div>
</body>
</html>
`;

const sendEmail = async ({ to, subject, html }) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP not configured — skipping email to:', to);
    console.warn('Subject:', subject);
    return;
  }
  const transporter = getTransporter();
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `${process.env.APP_NAME || 'CRM'} <noreply@yourcrm.com>`,
    to,
    subject,
    html,
  });
};

const sendVerificationEmail = async ({ to, name, token }) => {
  const url = `${process.env.CLIENT_URL}/verify-email?token=${token}`;
  await sendEmail({
    to,
    subject: 'Confirm your email address',
    html: baseTemplate(`
      <p>Hi ${name},</p>
      <p>Thanks for signing up! Please confirm your email address to activate your account.</p>
      <a href="${url}" class="btn">Confirm email</a>
      <hr class="divider"/>
      <p class="muted">This link expires in 24 hours. If the button doesn't work, copy and paste this link:</p>
      <p class="url-fallback">${url}</p>
    `),
  });
};

const sendPasswordResetEmail = async ({ to, name, token }) => {
  const url = `${process.env.CLIENT_URL}/reset-password?token=${token}`;
  await sendEmail({
    to,
    subject: 'Reset your password',
    html: baseTemplate(`
      <p>Hi ${name},</p>
      <p>We received a request to reset the password for your account. Click the button below to set a new password.</p>
      <a href="${url}" class="btn">Reset password</a>
      <hr class="divider"/>
      <p class="muted">This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password will not be changed.</p>
      <p class="muted">If the button doesn't work, copy and paste this link:</p>
      <p class="url-fallback">${url}</p>
    `),
  });
};

const sendInviteEmail = async ({ to, name, inviterName, orgName, inviteLink }) => {
  await sendEmail({
    to,
    subject: `${inviterName} invited you to join ${orgName} on ${process.env.APP_NAME || 'CRM'}`,
    html: baseTemplate(`
      <p>Hi ${name},</p>
      <p><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on ${process.env.APP_NAME || 'CRM'}.</p>
      <p>Click the button below to set up your account. This invite link expires in 7 days.</p>
      <a href="${inviteLink}" class="btn">Accept invitation</a>
      <hr class="divider"/>
      <p class="muted">If the button doesn't work, copy and paste this link:</p>
      <p class="url-fallback">${inviteLink}</p>
      <p class="muted">If you weren't expecting this invitation, you can safely ignore this email.</p>
    `),
  });
};

const sendWelcomeEmail = async ({ to, name, orgName }) => {
  await sendEmail({
    to,
    subject: `Welcome to ${process.env.APP_NAME || 'CRM'}, ${name}!`,
    html: baseTemplate(`
      <p>Hi ${name},</p>
      <p>Your account for <strong>${orgName}</strong> is all set up and ready to go.</p>
      <p>Here's what you can do right away:</p>
      <p>→ Add your first contacts<br/>
         → Set up your sales pipeline<br/>
         → Connect n8n for automations</p>
      <a href="${process.env.CLIENT_URL}" class="btn">Go to your CRM</a>
    `),
  });
};

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendInviteEmail,
};
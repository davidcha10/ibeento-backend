const nodemailer = require('nodemailer');
const { renderEmailTemplate } = require('../emails/templates');

function parseBool(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function getEmailConfig() {
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: parseBool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || '',
  };
}

let cachedTransporter = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const cfg = getEmailConfig();
  if (!cfg.user || !cfg.pass) {
    throw new Error('SMTP credentials are missing. Set SMTP_USER and SMTP_PASS.');
  }
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });
  return cachedTransporter;
}

async function sendEmail({ to, subject, html, text, attachments = [] }) {
  const cfg = getEmailConfig();
  if (!cfg.from) {
    throw new Error('EMAIL_FROM is missing.');
  }
  if (!to) {
    throw new Error('Recipient "to" is required.');
  }

  const transporter = getTransporter();
  return transporter.sendMail({
    from: cfg.from,
    to,
    subject,
    html,
    text,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
  });
}

async function sendTemplatedEmail({ to, templateKey, data = {} }) {
  const rendered = renderEmailTemplate(templateKey, data);
  return sendEmail({
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: rendered.attachments,
  });
}

module.exports = {
  sendEmail,
  sendTemplatedEmail,
};

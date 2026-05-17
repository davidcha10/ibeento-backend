const nodemailer = require('nodemailer');
const { renderEmailTemplate } = require('../emails/templates');
const EmailTemplate = require('../models/EmailTemplate');

const DB_TEMPLATE_KEY_MAP = {
  welcome: 'welcome_email',
};

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

function injectTemplateVars(template = '', vars = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = vars[key];
    return value == null ? '' : String(value);
  });
}

function htmlToText(html = '') {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapHtmlDocumentIfNeeded(rawHtml = '') {
  const html = String(rawHtml || '').trim();
  if (!html) return html;
  if (/<html[\s>]/i.test(html)) return html;

  const styleBlocks = [];
  const contentWithoutStyles = html.replace(/<style[\s\S]*?<\/style>/gi, (match) => {
    styleBlocks.push(match);
    return '';
  }).trim();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${styleBlocks.join('\n')}
  </head>
  <body>
    ${contentWithoutStyles}
  </body>
</html>`;
}

async function resolveRenderedTemplate(templateKey, data = {}) {
  const dbKey = DB_TEMPLATE_KEY_MAP[templateKey] || templateKey;
  const dbDoc = await EmailTemplate.findOne({ key: dbKey, isActive: true }).lean();
  const dbHtml = String(dbDoc?.code?.template || '').trim();

  if (dbHtml) {
    const html = wrapHtmlDocumentIfNeeded(injectTemplateVars(dbHtml, data));
    const subject = String(dbDoc?.code?.subject || '').trim() || 'IBeento';
    const text = String(dbDoc?.code?.text || '').trim() || htmlToText(html);
    return { subject, html, text };
  }

  return renderEmailTemplate(templateKey, data);
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
  const rendered = await resolveRenderedTemplate(templateKey, data);
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

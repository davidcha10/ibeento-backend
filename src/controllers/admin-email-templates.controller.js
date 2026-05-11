const EmailTemplate = require('../models/EmailTemplate');

function toKey(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalized || `email_${Date.now()}`;
}

function normalizePayload(body = {}) {
  const name = String(body.name || '').trim();
  const key = String(body.key || '').trim();
  return {
    name,
    key: toKey(key || name),
    isActive: !!body.isActive,
    code: body.code && typeof body.code === 'object' ? body.code : {},
  };
}

function welcomeTemplateHtml() {
  return `
<style>
  .mail-root { font-family: Inter, Arial, sans-serif; color: #111111; background: #f6f8fb; padding: 24px; }
  .mail-card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e5e7eb; overflow: hidden; }
  .mail-header { padding: 28px 28px 14px; }
  .mail-title { margin: 0; font-size: 28px; line-height: 1.2; letter-spacing: -0.3px; }
  .mail-title span { color: #1EA585; }
  .mail-body { padding: 0 28px 24px; color: #475569; font-size: 15px; line-height: 1.6; }
  .mail-cta { display: inline-block; margin-top: 12px; background: #1EA585; color: #fff !important; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-weight: 600; }
  .mail-footer { padding: 16px 28px 24px; color: #94a3b8; font-size: 12px; }
</style>
<div class="mail-root">
  <div class="mail-card">
    <div class="mail-header">
      <h1 class="mail-title">Welcome to <span>IBeento</span> ✈️</h1>
    </div>
    <div class="mail-body">
      <p>Your perfect trip starts here.</p>
      <p>We built IBeento to help you import ideas from social media, organize faster, and travel with less stress.</p>
      <a class="mail-cta" href="https://ibeento.com/trip">Start planning</a>
    </div>
    <div class="mail-footer">You received this email because you created an IBeento account.</div>
  </div>
</div>
`.trim();
}

function subscriptionEndsTomorrowTemplateHtml() {
  return `
<style>
  .mail-root { font-family: Inter, Arial, sans-serif; color: #111111; background: #f6f8fb; padding: 24px; }
  .mail-card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e5e7eb; overflow: hidden; }
  .mail-header { padding: 28px 28px 10px; }
  .mail-eyebrow { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #1EA585; font-weight: 700; }
  .mail-title { margin: 0; font-size: 28px; line-height: 1.2; letter-spacing: -0.3px; }
  .mail-body { padding: 0 28px 24px; color: #475569; font-size: 15px; line-height: 1.6; }
  .mail-cta { display: inline-block; margin-top: 12px; background: #1EA585; color: #fff !important; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-weight: 600; }
  .mail-footer { padding: 16px 28px 24px; color: #94a3b8; font-size: 12px; }
</style>
<div class="mail-root">
  <div class="mail-card">
    <div class="mail-header">
      <p class="mail-eyebrow">Subscription reminder</p>
      <h1 class="mail-title">Your IBeento trial ends tomorrow</h1>
    </div>
    <div class="mail-body">
      <p>Hi {{firstName}}, your 7-day free trial will end tomorrow.</p>
      <p>To keep unlimited access to trip planning, imports from social media, and AI itinerary building, your subscription will continue automatically unless you cancel before renewal.</p>
      <a class="mail-cta" href="https://ibeento.com/profile/subscription">Manage subscription</a>
    </div>
    <div class="mail-footer">Need help? Contact IBeento support anytime.</div>
  </div>
</div>
`.trim();
}

async function ensureBaselineTemplate() {
  const requiredTemplates = [
    {
      name: 'Welcome email',
      key: 'welcome_email',
      isActive: true,
      code: { template: welcomeTemplateHtml() },
    },
    {
      name: 'Subscription ends tomorrow',
      key: 'subscription_ends_tomorrow',
      isActive: true,
      code: { template: subscriptionEndsTomorrowTemplateHtml() },
    },
  ];

  for (const item of requiredTemplates) {
    const exists = await EmailTemplate.findOne({ key: item.key }).select('_id').lean();
    if (!exists) {
      await EmailTemplate.create(item);
    }
  }
}

exports.list = async (_req, res) => {
  try {
    await ensureBaselineTemplate();
    const items = await EmailTemplate.find({}).sort({ updatedAt: -1 }).lean();
    return res.json({ success: true, data: items });
  } catch (error) {
    console.error('[admin-email-templates.list]', error);
    return res.status(500).json({ success: false, error: 'Unable to list email templates.' });
  }
};

exports.create = async (req, res) => {
  try {
    const payload = normalizePayload(req.body || {});
    if (!payload.name) return res.status(400).json({ success: false, error: 'name is required' });
    const created = await EmailTemplate.create(payload);
    return res.status(201).json({ success: true, data: created });
  } catch (error) {
    console.error('[admin-email-templates.create]', error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, error: 'Email template name/key already exists.' });
    }
    return res.status(500).json({ success: false, error: 'Unable to create email template.' });
  }
};

exports.updateById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const payload = normalizePayload(req.body || {});
    if (!payload.name) return res.status(400).json({ success: false, error: 'name is required' });

    const updated = await EmailTemplate.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ success: false, error: 'Email template not found.' });
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error('[admin-email-templates.updateById]', error);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, error: 'Email template name/key already exists.' });
    }
    return res.status(500).json({ success: false, error: 'Unable to update email template.' });
  }
};

exports.removeById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });
    const removed = await EmailTemplate.findByIdAndDelete(id);
    if (!removed) return res.status(404).json({ success: false, error: 'Email template not found.' });
    return res.json({ success: true, data: { _id: removed._id } });
  } catch (error) {
    console.error('[admin-email-templates.removeById]', error);
    return res.status(500).json({ success: false, error: 'Unable to delete email template.' });
  }
};

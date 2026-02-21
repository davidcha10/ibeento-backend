const { sendEmail } = require('../services/email.service');

exports.sendTest = async (req, res) => {
  try {
    const body = req.body || {};
    const to = body.to || req.user?.email;

    const info = await sendEmail({
      to,
      subject: body.subject || 'Trip Planner test email',
      text: body.text || 'If you received this message, SMTP is configured correctly.',
      html:
        body.html ||
        '<div style="font-family:Arial,sans-serif;line-height:1.5"><h2>Trip Planner</h2><p>If you received this message, SMTP is configured correctly.</p></div>',
    });

    return res.json({
      success: true,
      messageId: info?.messageId || null,
      accepted: info?.accepted || [],
      rejected: info?.rejected || [],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || 'Failed to send email',
    });
  }
};

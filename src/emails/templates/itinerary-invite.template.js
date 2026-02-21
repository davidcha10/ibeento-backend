const { buildWebAppUrl } = require('../../utils/web-app-url');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = function renderItineraryInviteTemplate(data = {}) {
  const senderNameRaw = String(data.senderName || '').trim();
  const itineraryNameRaw = String(data.itineraryName || 'Shared trip').trim();
  const roleRaw = String(data.recipientRole || 'viewer').trim().toLowerCase();
  const roleLabel = roleRaw === 'editor' ? 'Editor' : 'Viewer';
  const ctaUrlRaw = typeof data.ctaUrl === 'string' && data.ctaUrl.trim()
    ? data.ctaUrl.trim()
    : buildWebAppUrl('/trip');

  const senderName = escapeHtml(senderNameRaw || 'A teammate');
  const itineraryName = escapeHtml(itineraryNameRaw);
  const ctaUrl = escapeHtml(ctaUrlRaw);

  const subject = `${senderNameRaw || 'A teammate'} shared an itinerary with you`;
  const text = `${senderNameRaw || 'A teammate'} shared "${itineraryNameRaw}" with you as ${roleLabel}. Open it: ${ctaUrlRaw}`;

  return {
    subject,
    text,
    html: `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f8f7;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:24px 12px;background:#f4f8f7;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#fff;border:1px solid #dce9e6;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="background:linear-gradient(135deg,#1ea585 0%,#0f7f68 100%);padding:24px 26px;">
                <h1 style="margin:0;color:#fff;font-size:26px;line-height:1.2;font-weight:800;">Itinerary Invitation</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 26px;color:#0f172a;">
                <p style="margin:0 0 10px;font-size:16px;line-height:1.45;">
                  <strong>${senderName}</strong> shared an itinerary with you:
                </p>
                <p style="margin:0 0 8px;font-size:20px;line-height:1.3;font-weight:800;color:#0f7f68;">${itineraryName}</p>
                <p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#475569;">
                  Your role: <strong>${roleLabel}</strong>
                </p>
                <a href="${ctaUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#1ea585;color:#fff;text-decoration:none;font-size:14px;font-weight:700;">
                  Open itinerary
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 26px 22px;font-size:12px;line-height:1.55;color:#8b9aa7;">
                If you do not recognize this invitation, you can ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `,
    attachments: [],
  };
};

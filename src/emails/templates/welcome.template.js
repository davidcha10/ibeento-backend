const { getWebAppBaseUrl } = require('../../utils/web-app-url');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const fs = require('fs');
const path = require('path');

module.exports = function renderWelcomeTemplate(data = {}) {
  const safeNameRaw = typeof data.name === 'string' ? data.name.trim() : '';
  const safeName = safeNameRaw ? escapeHtml(safeNameRaw) : '';
  const firstLine = safeName ? `Hi ${safeNameRaw}, welcome to Trip Planner.` : 'Welcome to Trip Planner.';
  const text = `${firstLine} Your account is ready.`;
  const ctaUrlRaw = typeof data.ctaUrl === 'string' && data.ctaUrl.trim()
    ? data.ctaUrl.trim()
    : getWebAppBaseUrl();
  const ctaUrl = escapeHtml(ctaUrlRaw);
  const logoFilePath = path.resolve(__dirname, '../../../../frontend/src/assets/logo-b-white.png');
  const hasLocalLogo = fs.existsSync(logoFilePath);
  const logoCid = 'tripplanner-logo-white';
  const logoUrlRaw = typeof data.logoUrl === 'string' && data.logoUrl.trim()
    ? data.logoUrl.trim()
    : (process.env.EMAIL_LOGO_URL || '');
  const logoSrc = hasLocalLogo ? `cid:${logoCid}` : escapeHtml(logoUrlRaw || 'https://www.ibeento.com/assets/logo-b-white.png');
  const heading = safeName ? `Welcome aboard, ${safeName}` : 'Welcome aboard';

  return {
    subject: 'Welcome to Trip Planner',
    text,
    html: `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Welcome to Trip Planner</title>
    <style>
      body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
      table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
      table { border-collapse: collapse !important; }
      body { margin: 0 !important; padding: 0 !important; width: 100% !important; background: #f4f8f7; }
      .wrapper { width: 100%; padding: 24px 12px; background: #f4f8f7; }
      .container { width: 100%; max-width: 600px; margin: 0 auto; }
      .card { background: #ffffff; border: 1px solid #dce9e6; border-radius: 18px; overflow: hidden; }
      .hero { background: linear-gradient(135deg, #1ea585 0%, #0f7f68 100%); padding: 26px 28px; }
      .brand-row { display: inline-table; width: auto; border-collapse: separate; }
      .brand-logo-cell {
        width: auto;
        height: auto;
        text-align: center;
        vertical-align: middle;
      }
      .brand-logo-cell img {
        width: auto;
        height: 28px;
        display: block;
        margin: 0 auto;
      }
      .brand-text-cell {
        padding-left: 10px;
        vertical-align: middle;
      }
      .brand {
        margin: 0;
        font-family: Inter, Segoe UI, Arial, sans-serif;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.8px;
        color: #d9fff6;
        text-transform: uppercase;
      }
      .hero-title { margin: 10px 0 0; font-family: Inter, Segoe UI, Arial, sans-serif; font-size: 28px; line-height: 1.2; font-weight: 800; color: #ffffff; }
      .content { padding: 26px 28px 30px; font-family: Inter, Segoe UI, Arial, sans-serif; color: #0f172a; }
      .greeting { margin: 0; font-size: 18px; line-height: 1.35; font-weight: 700; color: #0f172a; }
      .copy { margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: #475569; }
      .cta-wrap { margin: 22px 0 18px; }
      .cta {
        display: inline-block;
        padding: 12px 20px;
        border-radius: 999px;
        background: #1ea585;
        color: #ffffff !important;
        font-size: 14px;
        font-weight: 700;
        text-decoration: none;
      }
      .tips { margin: 0; padding: 0; list-style: none; }
      .tip { margin: 0 0 8px; font-size: 13px; line-height: 1.5; color: #334155; }
      .tip strong { color: #0f7f68; }
      .section-title {
        margin: 18px 0 10px;
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.2px;
        text-transform: uppercase;
        color: #0f7f68;
      }
      .feature-table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
      .feature-card {
        border: 1px solid #e2ecea;
        border-radius: 12px;
        background: #f8fbfa;
        padding: 10px 12px;
      }
      .feature-title {
        margin: 0 0 4px;
        font-size: 13px;
        line-height: 1.3;
        font-weight: 700;
        color: #0f172a;
      }
      .feature-copy {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: #475569;
      }
      .quick-start {
        margin: 14px 0 0;
        padding: 12px;
        border: 1px dashed #b7ddd5;
        border-radius: 12px;
        background: #f2fbf8;
      }
      .quick-start p {
        margin: 0 0 6px;
        font-size: 12px;
        line-height: 1.5;
        color: #0f7f68;
      }
      .footer {
        padding: 0 28px 26px;
        font-family: Inter, Segoe UI, Arial, sans-serif;
        color: #94a3b8;
        font-size: 12px;
        line-height: 1.6;
      }
      @media screen and (max-width: 600px) {
        .wrapper { padding: 16px 8px; }
        .hero { padding: 22px 20px; }
        .hero-title { font-size: 24px; }
        .content { padding: 22px 20px 24px; }
        .footer { padding: 0 20px 20px; }
        .brand-logo-cell img { height: 24px; }
        .cta { width: 100%; text-align: center; box-sizing: border-box; }
      }
    </style>
  </head>
  <body>
    <table role="presentation" class="wrapper" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center">
          <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td class="card">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="hero">
                      <table role="presentation" class="brand-row" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td class="brand-logo-cell">
                            <img src="${logoSrc}" height="28" alt="Trip Planner logo">
                          </td>
                          <td class="brand-text-cell"><p class="brand">Trip Planner</p></td>
                        </tr>
                      </table>
                      <h1 class="hero-title">${heading}</h1>
                    </td>
                  </tr>
                  <tr>
                    <td class="content">
                      <p class="greeting">${text}</p>
                      <p class="copy">Plan your days, discover experiences, and keep everything in one place.</p>
                      <div class="cta-wrap">
                        <a href="${ctaUrl}" target="_blank" rel="noopener noreferrer" class="cta">Open Trip Planner</a>
                      </div>
                      <ul class="tips">
                        <li class="tip"><strong>Discover:</strong> find top experiences by destination.</li>
                        <li class="tip"><strong>Timeline:</strong> organize your trip day by day.</li>
                        <li class="tip"><strong>Map:</strong> visualize routes and nearby places.</li>
                      </ul>

                      <p class="section-title">What You Can Do</p>
                      <table role="presentation" class="feature-table" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td class="feature-card">
                            <p class="feature-title">Build day-by-day itineraries</p>
                            <p class="feature-copy">Set trip dates and arrange activities in timeline format so your plan stays clear and actionable.</p>
                          </td>
                        </tr>
                        <tr>
                          <td class="feature-card">
                            <p class="feature-title">Find curated experiences</p>
                            <p class="feature-copy">Explore destination-based recommendations and save favorites before adding them to your trip.</p>
                          </td>
                        </tr>
                        <tr>
                          <td class="feature-card">
                            <p class="feature-title">Visualize routes on the map</p>
                            <p class="feature-copy">Review where each place is located and optimize your daily route to reduce back-and-forth.</p>
                          </td>
                        </tr>
                      </table>

                      <div class="quick-start">
                        <p><strong>Quick start:</strong> add your destination, choose dates, then pick your first 2-3 activities.</p>
                        <p style="margin:0;">From there, Trip Planner helps you organize the rest in minutes.</p>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td class="footer">
                      Need help? Reply to this email and we will guide you.
                      <br>
                      If you did not create this account, you can ignore this message.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `,
    attachments: hasLocalLogo
      ? [
          {
            filename: 'logo-b-white.png',
            path: logoFilePath,
            cid: logoCid,
          },
        ]
      : [],
  };
};

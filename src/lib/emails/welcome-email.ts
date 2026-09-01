export type WelcomeEmailParams = {
  fullName: string;
  workEmail: string;
  employeeCode: string;
  categoryLabel: string;
  roleLabel: string;
  portalUrl: string;
};

export function renderWelcomeEmailHtml(params: WelcomeEmailParams): string {
  const { fullName, workEmail, employeeCode, categoryLabel, roleLabel, portalUrl } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to The AI School HRM Portal</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #18181b;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #f4f4f5;
      padding: 32px 16px;
    }
    .container {
      max-width: 560px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
      border: 1px solid #e4e4e7;
    }
    .header {
      padding: 28px 32px 20px;
      text-align: center;
      background-color: #ffffff;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #09090b;
      margin: 0;
      text-transform: uppercase;
    }
    .brand-title span {
      color: #e11d48;
    }
    .brand-bar {
      height: 3px;
      background: linear-gradient(90deg, #e11d48 0%, #f43f5e 100%);
      width: 100%;
      margin-top: 16px;
    }
    .content {
      padding: 32px;
    }
    .wave-icon {
      font-size: 32px;
      line-height: 1;
      display: inline-block;
      background: #fef3c7;
      padding: 10px;
      border-radius: 50%;
      margin-bottom: 16px;
    }
    .salutation {
      font-size: 16px;
      color: #52525b;
      margin: 0 0 6px 0;
    }
    .heading {
      font-size: 24px;
      font-weight: 700;
      color: #09090b;
      margin: 0 0 16px 0;
      letter-spacing: -0.3px;
    }
    .lead-text {
      font-size: 15px;
      line-height: 1.6;
      color: #3f3f46;
      margin: 0 0 24px 0;
    }
    .card {
      background-color: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
      margin: 0 0 14px 0;
    }
    .cred-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #f1f5f9;
      font-size: 14px;
    }
    .cred-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .cred-label {
      color: #64748b;
      font-weight: 500;
    }
    .cred-value {
      font-weight: 600;
      color: #0f172a;
    }
    .emp-id-badge {
      display: inline-block;
      background-color: #ffe4e6;
      color: #e11d48;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 700;
      font-size: 15px;
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid #fecdd3;
    }
    .security-notice {
      background-color: #f1f5f9;
      border-left: 3px solid #64748b;
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.5;
      color: #475569;
      margin-top: 14px;
      border-radius: 0 6px 6px 0;
    }
    .steps-list {
      margin: 0;
      padding: 0 0 0 20px;
      color: #3f3f46;
      font-size: 14px;
      line-height: 1.7;
    }
    .steps-list li {
      margin-bottom: 8px;
    }
    .button-wrap {
      text-align: center;
      margin: 28px 0;
    }
    .cta-btn {
      display: inline-block;
      background-color: #e11d48;
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      padding: 13px 32px;
      border-radius: 6px;
      box-shadow: 0 2px 6px rgba(225, 29, 72, 0.3);
    }
    .footer {
      border-top: 1px solid #e4e4e7;
      padding: 24px 32px;
      background-color: #fafafa;
      font-size: 13px;
      color: #71717a;
      line-height: 1.6;
    }
    .footer a {
      color: #e11d48;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1 class="brand-title">THE <span>AI SCHOOL</span></h1>
        <div class="brand-bar"></div>
      </div>
      <div class="content">
        <div class="wave-icon">&#128075;</div>
        <p class="salutation">Dear ${escapeHtml(fullName)},</p>
        <h2 class="heading">Welcome aboard!</h2>
        
        <p class="lead-text">
          Congratulations on joining <strong>The AI School</strong>! We're thrilled to have you as part of our team. Get ready to collaborate on pioneering AI initiatives, manage your daily work logs, and grow with us.
        </p>

        <div class="card">
          <div class="card-title">Your Employee Details &amp; Login</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size: 14px;">
            <tr>
              <td style="padding: 8px 0; color: #64748b;"><strong>Employee ID:</strong></td>
              <td style="padding: 8px 0; text-align: right;"><span class="emp-id-badge">${escapeHtml(employeeCode)}</span></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; border-top: 1px solid #f1f5f9;"><strong>Work Email:</strong></td>
              <td style="padding: 8px 0; text-align: right; font-weight: 600; color: #0f172a; border-top: 1px solid #f1f5f9;">${escapeHtml(workEmail)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; border-top: 1px solid #f1f5f9;"><strong>Category &amp; Role:</strong></td>
              <td style="padding: 8px 0; text-align: right; color: #0f172a; border-top: 1px solid #f1f5f9;">${escapeHtml(categoryLabel)} · ${escapeHtml(roleLabel)}</td>
            </tr>
          </table>

          <div class="security-notice">
            <strong>Security Notice:</strong> You set your own secure password when accepting your invitation. For your protection, passwords are never sent by email. If you ever forget your password, simply use the "Reset password" flow on the portal sign-in page.
          </div>
        </div>

        <div class="card" style="background-color: #ffffff; border-color: #e4e4e7;">
          <div class="card-title" style="color: #09090b;">How to Get Started</div>
          <ol class="steps-list">
            <li><strong>Sign in to your account:</strong> Use your work email (<code>${escapeHtml(workEmail)}</code>) and your password.</li>
            <li><strong>Complete Onboarding:</strong> Review your profile details and submit your onboarding documents for HR verification.</li>
            <li><strong>Begin Daily Operations:</strong> Log attendance, record hourly project slot allocations, and submit your daily End-of-Day (EOD) reports.</li>
          </ol>
        </div>

        <div class="button-wrap">
          <a href="${escapeHtml(portalUrl)}" class="cta-btn" target="_blank">Access HRM Portal &rarr;</a>
        </div>
      </div>

      <div class="footer">
        <p style="margin: 0 0 10px 0;">
          If you need assistance or have questions, our HR team is just an email away at <a href="mailto:hr@theaischool.co">hr@theaischool.co</a> or <a href="mailto:support@theaischool.co">support@theaischool.co</a>.
        </p>
        <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
          &copy; ${new Date().getFullYear()} The AI School &middot; Internal HRM Portal &middot; <a href="${escapeHtml(portalUrl)}">${escapeHtml(portalUrl.replace(/^https?:\/\//, ""))}</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

import { Handler } from "@netlify/functions";
import nodemailer from "nodemailer";

const handler: Handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return { 
      statusCode: 405, 
      body: JSON.stringify({ error: "Method Not Allowed" }) 
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { email, inviterName, groupName, inviteLink } = body;

    if (!email || !inviteLink) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email or inviteLink" }),
      };
    }

    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const host = process.env.SMTP_HOST || "smtp.gmail.com";
    const port = parseInt(process.env.SMTP_PORT || "587");
    const secure = process.env.SMTP_SECURE === "true";

    if (!user || !pass) {
      return {
        statusCode: 503,
        body: JSON.stringify({ error: "Email service not configured on host. Please set SMTP_USER and SMTP_PASS environment variables." }),
      };
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const mailOptions = {
      from: `"HappyShare" <${user}>`,
      to: email,
      subject: `[HappyShare] ${inviterName} mời bạn tham gia nhóm ${groupName || "mới"}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.6;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="font-size: 48px; margin-bottom: 10px;">💸</div>
            <h1 style="color: #7c3aed; margin: 0;">HappyShare</h1>
          </div>
          
          <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(124,58,237,0.05);">
            <h2 style="margin-top: 0; color: #1e1e2e;">Chào bạn!</h2>
            <p><strong>${inviterName}</strong> đã mời bạn tham gia nhóm <strong>${groupName || "mới"}</strong> trên ứng dụng HappyShare.</p>
            
            <div style="text-align: center; margin: 32px 0;">
              <a href="${inviteLink}" style="background: #7c3aed; color: #ffffff; padding: 14px 28px; border-radius: 12px; text-decoration: none; font-weight: bold; display: inline-block; font-size: 16px; box-shadow: 0 4px 14px rgba(124,58,237,0.4);">Tham gia nhóm ngay 🚀</a>
            </div>
            
            <p style="font-size: 14px; color: #64748b; margin-bottom: 0;">Sử dụng HappyShare để quản lý chi tiêu nhóm một cách công bằng và minh bạch nhất.</p>
          </div>
          
          <div style="text-align: center; margin-top: 24px; font-size: 12px; color: #94a3b8;">
            <p>© 2026 HappyShare — Tiền bạc phân minh, tình mình bền lâu.</p>
          </div>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error("Email sending error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err instanceof Error ? err.message : "Failed to send email" }),
    };
  }
};

export { handler };

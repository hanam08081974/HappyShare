import express from "express";
import nodemailer from "nodemailer";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

// Transporter setup
// Note: User needs to provide these in their environment settings
// We use lazy initialization to prevent crash on startup if keys are missing
let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter) {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    
    if (!user || !pass) {
      console.warn("SMTP_USER or SMTP_PASS not set. Email invitations will not be sent.");
      return null;
    }

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user, pass },
    });
  }
  return transporter;
}

app.post("/api/invite", async (req, res) => {
  const { email, inviterName, groupName, inviteLink } = req.body;

  if (!email || !inviteLink) {
    return res.status(400).json({ error: "Missing email or inviteLink" });
  }

  const mailTransporter = getTransporter();
  if (!mailTransporter) {
    return res.status(503).json({ error: "Email service not configured. Please set SMTP_USER and SMTP_PASS." });
  }

  try {
    const mailOptions = {
      from: `"HappyShare" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `[HappyShare] ${inviterName} mời bạn tham gia nhóm ${groupName || ""}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.6;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="font-size: 48px; margin-bottom: 10px;">💸</div>
            <h1 style="color: #7c3aed; margin: 0;">HappyShare</h1>
          </div>
          
          <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 12px rgba(124,58,237,0.05);">
            <h2 style="margin-top: 0; color: #1e1e2e;">Chào bạn!</h2>
            <p><strong>${inviterName}</strong> đã mời bạn tham gia nhóm <strong>${groupName}</strong> trên ứng dụng HappyShare.</p>
            
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

    await mailTransporter.sendMail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error("Email sending error:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

async function startServer() {
  const PORT = 3000;

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distPath)) {
      console.error("Production dist directory not found!");
    }
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

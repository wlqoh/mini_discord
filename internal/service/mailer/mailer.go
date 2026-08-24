// Package mailer sends transactional email (currently just email
// verification) over SMTP, speaking the protocol directly rather than via
// net/smtp.SendMail so the whole conversation can be bounded by a single
// deadline.
package mailer

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/config"
)

const sendTimeout = 10 * time.Second

// Mailer sends email over SMTP using cfg.
type Mailer struct {
	cfg config.MailConfig
}

// New builds a Mailer from cfg. It does not connect to anything yet; see
// Configured for whether it is usable.
func New(cfg config.MailConfig) *Mailer {
	return &Mailer{cfg: cfg}
}

// Configured reports whether enough SMTP settings are present to attempt a send.
func (m *Mailer) Configured() bool {
	return m.cfg.SMTPHost != "" && m.cfg.FromAddress != ""
}

// SendVerificationEmail sends the "confirm your email" message containing
// verifyURL, as a multipart/alternative (plain text + HTML) message.
func (m *Mailer) SendVerificationEmail(to, recipientName, verifyURL string) error {
	subject := "Confirm your email address"

	plainText := fmt.Sprintf(
		"Hi %s,\r\n\r\n"+
			"Please confirm your email address by clicking the link below:\r\n%s\r\n\r\n"+
			"This link expires in 24 hours. If you did not create this account, you can ignore this email.\r\n",
		recipientName, verifyURL,
	)

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm your email</title>
</head>
<body style="margin:0;padding:0;background:#1a1a2e;font-family:Arial,sans-serif;">
<table width="100%%" cellpadding="0" cellspacing="0" style="background:#1a1a2e;padding:40px 0;">
  <tr>
    <td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#16213e;border-radius:12px;overflow:hidden;">
        <!-- header -->
        <tr>
          <td style="background:#0f3460;padding:32px 40px;text-align:center;">
            <span style="font-size:28px;font-weight:700;color:#e94560;letter-spacing:1px;">MuArAb</span>
          </td>
        </tr>
        <!-- body -->
        <tr>
          <td style="padding:40px;">
            <h2 style="margin:0 0 16px;color:#ffffff;font-size:22px;">Hi %s,</h2>
            <p style="margin:0 0 24px;color:#a8b2d8;font-size:15px;line-height:1.6;">
              Thanks for signing up! Please confirm your email address to activate your account.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
              <tr>
                <td style="border-radius:8px;background:#e94560;">
                  <a href="%s"
                     style="display:inline-block;padding:14px 36px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;letter-spacing:0.5px;">
                    Verify Email
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;color:#6b7280;font-size:13px;text-align:center;">
              Button not working? Copy and paste this link into your browser:
            </p>
            <p style="margin:0;word-break:break-all;font-size:12px;color:#4f8cc9;text-align:center;">
              <a href="%s" style="color:#4f8cc9;">%s</a>
            </p>
          </td>
        </tr>
        <!-- footer -->
        <tr>
          <td style="padding:24px 40px;border-top:1px solid #0f3460;text-align:center;">
            <p style="margin:0;color:#6b7280;font-size:12px;">
              This link expires in 24 hours.<br>
              If you did not create this account, you can safely ignore this email.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`, recipientName, verifyURL, verifyURL, verifyURL)

	return m.sendMultipart(to, subject, plainText, htmlBody)
}

// sendMultipart sends a multipart/alternative email with a plain-text and HTML part.
func (m *Mailer) sendMultipart(to, subject, plainText, htmlBody string) error {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Errorf("mailer: boundary rand: %w", err)
	}
	boundary := "==MuArAb" + hex.EncodeToString(b) + "=="

	var msg strings.Builder

	fromHeader := m.cfg.FromAddress
	if m.cfg.FromName != "" {
		fromHeader = fmt.Sprintf("%s <%s>", m.cfg.FromName, m.cfg.FromAddress)
	}

	fmt.Fprintf(&msg, "From: %s\r\n", fromHeader)
	fmt.Fprintf(&msg, "To: %s\r\n", to)
	fmt.Fprintf(&msg, "Subject: %s\r\n", subject)
	msg.WriteString("MIME-Version: 1.0\r\n")
	fmt.Fprintf(&msg, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n", boundary)
	msg.WriteString("\r\n")

	// plain-text part
	fmt.Fprintf(&msg, "--%s\r\n", boundary)
	msg.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	msg.WriteString("\r\n")
	msg.WriteString(plainText)
	msg.WriteString("\r\n")

	// HTML part
	fmt.Fprintf(&msg, "--%s\r\n", boundary)
	msg.WriteString("Content-Type: text/html; charset=\"utf-8\"\r\n")
	msg.WriteString("\r\n")
	msg.WriteString(htmlBody)
	msg.WriteString("\r\n")

	fmt.Fprintf(&msg, "--%s--\r\n", boundary)

	return m.dial(to, msg.String())
}

// dial speaks SMTP manually so the whole conversation is bounded by a deadline.
func (m *Mailer) dial(to, rawMsg string) error {
	if !m.Configured() {
		return fmt.Errorf("mailer: SMTP is not configured")
	}

	addr := net.JoinHostPort(m.cfg.SMTPHost, strconv.Itoa(m.cfg.SMTPPort))

	var conn net.Conn
	var err error
	// Port 465 is implicit TLS (SMTPS): the server expects a TLS handshake
	// immediately, with no STARTTLS negotiation over plaintext first.
	if m.cfg.SMTPPort == 465 {
		dialer := &net.Dialer{Timeout: sendTimeout}
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: m.cfg.SMTPHost})
	} else {
		conn, err = net.DialTimeout("tcp", addr, sendTimeout)
	}
	if err != nil {
		return fmt.Errorf("mailer: dial: %w", err)
	}
	if err := conn.SetDeadline(time.Now().Add(sendTimeout)); err != nil {
		_ = conn.Close()
		return fmt.Errorf("mailer: set deadline: %w", err)
	}

	client, err := smtp.NewClient(conn, m.cfg.SMTPHost)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("mailer: new client: %w", err)
	}
	defer func() { _ = client.Close() }()

	if m.cfg.SMTPPort != 465 {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: m.cfg.SMTPHost}); err != nil {
				return fmt.Errorf("mailer: starttls: %w", err)
			}
		}
	}

	if m.cfg.SMTPUsername != "" {
		if ok, _ := client.Extension("AUTH"); ok {
			auth := smtp.PlainAuth("", m.cfg.SMTPUsername, m.cfg.SMTPPassword, m.cfg.SMTPHost)
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("mailer: auth: %w", err)
			}
		}
	}

	if err := client.Mail(m.cfg.FromAddress); err != nil {
		return fmt.Errorf("mailer: mail from: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("mailer: rcpt to: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("mailer: data: %w", err)
	}
	if _, err := w.Write([]byte(rawMsg)); err != nil {
		_ = w.Close()
		return fmt.Errorf("mailer: write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("mailer: close body: %w", err)
	}

	return client.Quit()
}

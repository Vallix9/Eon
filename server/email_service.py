import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import config

logger = logging.getLogger(__name__)


def send_email(to_email: str, subject: str, html_body: str) -> bool:
    try:
        msg = MIMEMultipart("alternative")
        msg["From"] = config.SMTP_FROM
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=10) as server:
            server.starttls()
            server.login(config.SMTP_USER, config.SMTP_PASSWORD)
            server.sendmail(config.SMTP_FROM, to_email, msg.as_string())
        return True
    except Exception as e:
        logger.warning(f"Email send failed to {to_email}: {e}")
        return False


def send_verification_email(to_email: str, token: str) -> bool:
    verify_link = f"http://localhost:8000/api/auth/verify?token={token}"
    html = f"""
    <html><body style="font-family:sans-serif;padding:20px;">
        <h2>Добро пожаловать в Eon!</h2>
        <p>Подтвердите ваш email, перейдя по ссылке:</p>
        <a href="{verify_link}" style="display:inline-block;padding:12px 24px;background:#667eea;color:#fff;border-radius:8px;text-decoration:none;margin:16px 0;">Подтвердить email</a>
        <p style="color:#888;font-size:12px;">Ссылка действительна 24 часа.</p>
    </body></html>
    """
    return send_email(to_email, "Подтверждение email — Eon", html)

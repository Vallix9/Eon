import os
import sys

# Определяем базовую директорию: рядом с .exe или рядом с config.py
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SECRET_KEY = "eon-super-secret-key-change-in-production-2026"
JWT_SECRET_KEY = "eon-jwt-secret-key-change-in-production-2026"
JWT_TOKEN_LOCATION = ["headers", "cookies"]
JWT_ACCESS_TOKEN_EXPIRES = 2592000  # 30 дней
JWT_COOKIE_SECURE = False
JWT_COOKIE_CSRF_PROTECT = False

SQLALCHEMY_DATABASE_URI = f"sqlite:///{os.path.join(BASE_DIR, 'chat.db')}"
SQLALCHEMY_TRACK_MODIFICATIONS = False

UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
MAX_CONTENT_LENGTH = 50 * 1024 * 1024

# Email (SMTP) — настрой под свой почтовый сервер
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
SMTP_USER = "your-email@gmail.com"
SMTP_PASSWORD = "your-app-password"
SMTP_FROM = "noreply@eon.chat"

# Rate limits (requests per window)
RATE_LIMIT_LOGIN = (5, 60)       # 5 попыток в минуту
RATE_LIMIT_REGISTER = (3, 300)   # 3 регистрации в 5 минут
RATE_LIMIT_2FA = (5, 300)        # 5 попыток 2FA в 5 минут
RATE_LIMIT_EMAIL = (2, 300)      # 2 письма в 5 минут
RATE_LIMIT_GLOBAL = (200, 60)    # 200 запросов в минуту

# Путь к ресурсам (templates, static) при запуске из .exe
if getattr(sys, 'frozen', False):
    RESOURCE_DIR = sys._MEIPASS
else:
    RESOURCE_DIR = BASE_DIR

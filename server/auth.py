from flask import Blueprint, request, jsonify
from flask_jwt_extended import (
    create_access_token, set_access_cookies, unset_jwt_cookies,
    jwt_required, get_jwt_identity
)
from models import db, User
from email_service import send_verification_email
from phone_service import send_sms_code, generate_sms_code
from rate_limiter import rate_limit
import bcrypt
import pyotp
import io
import base64
from datetime import datetime, timezone, timedelta
import config

auth_bp = Blueprint("auth", __name__)

# In-memory temp tokens for 2FA flow
_temp_2fa_tokens = {}  # token -> user_id (expires in 5 min)


@auth_bp.route("/api/auth/register", methods=["POST"])
@rate_limit(*config.RATE_LIMIT_REGISTER)
def register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    nickname = data.get("nickname", "").strip() or username
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")
    phone = data.get("phone", "").strip()

    if not all([username, email, password]):
        return jsonify({"error": "Все поля обязательны"}), 400
    if len(username) < 3:
        return jsonify({"error": "Логин минимум 3 символа"}), 400
    if not any(c.isupper() for c in password) or not any(c.isdigit() for c in password) or len(password) < 8:
        return jsonify({"error": "Пароль: мин. 8 символов, заглавная буква и цифра"}), 400
    if nickname and len(nickname) < 2:
        return jsonify({"error": "Никнейм минимум 2 символа"}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Логин уже занят"}), 409
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "Email уже зарегистрирован"}), 409
    if phone:
        phone = phone.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
        if not phone.startswith("+") or len(phone) < 10:
            return jsonify({"error": "Телефон должен быть в формате +71234567890"}), 400
        if User.query.filter_by(phone=phone).first():
            return jsonify({"error": "Телефон уже используется"}), 409

    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    verification_token = User.generate_verification_token()
    user = User(
        username=username,
        nickname=nickname,
        email=email,
        phone=phone if phone else None,
        password_hash=pw_hash,
        verification_token=verification_token,
        is_verified=False,
    )
    db.session.add(user)
    db.session.commit()

    # Auto-send SMS code if phone provided
    if phone:
        code = send_sms_code(phone)
        if code:
            user.phone_code = code
            user.phone_code_expires = datetime.now(timezone.utc) + timedelta(minutes=5)
            db.session.commit()

    # Send verification email (async-friendly, non-blocking)
    send_verification_email(email, verification_token)

    access_token = create_access_token(identity=str(user.id))
    resp = jsonify({
        "message": "Регистрация успешна. Проверьте почту для подтверждения.",
        "user": user.to_dict(full=True),
        "token": access_token,
    })
    set_access_cookies(resp, access_token)
    return resp, 201


@auth_bp.route("/api/auth/login", methods=["POST"])
@rate_limit(*config.RATE_LIMIT_LOGIN)
def login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not all([username, password]):
        return jsonify({"error": "Все поля обязательны"}), 400

    user = User.query.filter_by(username=username).first()
    if not user or not bcrypt.checkpw(password.encode(), user.password_hash.encode()):
        return jsonify({"error": "Неверный логин или пароль"}), 401

    # If 2FA enabled, return temp token
    if user.totp_enabled:
        temp_token = User.generate_verification_token()  # reuse as temp token
        _temp_2fa_tokens[temp_token] = {"user_id": user.id, "expires": datetime.now(timezone.utc).timestamp() + 300}
        return jsonify({
            "requires_2fa": True,
            "temp_token": temp_token,
            "message": "Введите код из Google Authenticator",
        }), 200

    user.is_online = True
    user.last_seen = datetime.now(timezone.utc)
    db.session.commit()

    access_token = create_access_token(identity=str(user.id))
    resp = jsonify({
        "message": "Вход выполнен",
        "user": user.to_dict(full=True),
        "token": access_token,
    })
    set_access_cookies(resp, access_token)
    return resp, 200


@auth_bp.route("/api/auth/2fa/verify", methods=["POST"])
@rate_limit(*config.RATE_LIMIT_2FA)
def verify_2fa():
    data = request.get_json() or {}
    temp_token = data.get("temp_token", "")
    code = data.get("code", "").strip()

    if not temp_token or not code:
        return jsonify({"error": "Требуется temp_token и код"}), 400

    token_data = _temp_2fa_tokens.pop(temp_token, None)
    if not token_data:
        return jsonify({"error": "Недействительный или просроченный токен"}), 401

    if datetime.now(timezone.utc).timestamp() > token_data["expires"]:
        return jsonify({"error": "Токен истёк"}), 401

    user = db.session.get(User, token_data["user_id"])
    if not user or not user.totp_secret:
        return jsonify({"error": "2FA не настроена"}), 400

    totp = pyotp.TOTP(user.totp_secret)
    if not totp.verify(code, valid_window=1):
        return jsonify({"error": "Неверный код"}), 401

    user.is_online = True
    user.last_seen = datetime.now(timezone.utc)
    db.session.commit()

    access_token = create_access_token(identity=str(user.id))
    resp = jsonify({
        "message": "Вход выполнен",
        "user": user.to_dict(full=True),
        "token": access_token,
    })
    set_access_cookies(resp, access_token)
    return resp, 200


@auth_bp.route("/api/auth/verify", methods=["GET"])
def verify_email():
    token = request.args.get("token", "")
    if not token:
        return jsonify({"error": "Требуется токен"}), 400
    user = User.query.filter_by(verification_token=token).first()
    if not user:
        return jsonify({"error": "Недействительный токен"}), 404
    user.is_verified = True
    user.verification_token = None
    db.session.commit()
    return jsonify({"message": "Email подтверждён"}), 200


@auth_bp.route("/api/auth/resend-verification", methods=["POST"])
@jwt_required()
@rate_limit(*config.RATE_LIMIT_EMAIL)
def resend_verification():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    if user.is_verified:
        return jsonify({"error": "Email уже подтверждён"}), 400
    user.verification_token = User.generate_verification_token()
    db.session.commit()
    send_verification_email(user.email, user.verification_token)
    return jsonify({"message": "Письмо отправлено"}), 200


@auth_bp.route("/api/auth/logout", methods=["POST"])
@jwt_required()
def logout():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if user:
        user.is_online = False
        user.last_seen = datetime.now(timezone.utc)
        db.session.commit()
    resp = jsonify({"message": "Выход выполнен"})
    unset_jwt_cookies(resp)
    return resp, 200


@auth_bp.route("/api/auth/me", methods=["GET"])
@jwt_required()
def me():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    return jsonify({"user": user.to_dict(full=True)}), 200


# --- Phone verification ---
@auth_bp.route("/api/auth/phone/send-code", methods=["POST"])
@jwt_required()
@rate_limit(*config.RATE_LIMIT_EMAIL)
def send_phone_code():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    if user.phone_verified:
        return jsonify({"error": "Телефон уже подтверждён"}), 400
    if not user.phone:
        return jsonify({"error": "Телефон не указан. Укажите его в настройках."}), 400

    code = send_sms_code(user.phone)
    if not code:
        code = generate_sms_code()
        print(f"[DEV] SMS code for {user.phone}: {code}")

    user.phone_code = code
    user.phone_code_expires = datetime.now(timezone.utc) + timedelta(minutes=5)
    db.session.commit()
    return jsonify({"message": "Код отправлен на ваш телефон"}), 200


@auth_bp.route("/api/auth/phone/verify", methods=["POST"])
@jwt_required()
def verify_phone():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    if user.phone_verified:
        return jsonify({"error": "Телефон уже подтверждён"}), 400

    data = request.get_json() or {}
    code = data.get("code", "").strip()
    if not code or not user.phone_code:
        return jsonify({"error": "Сначала запросите код"}), 400

    if datetime.now(timezone.utc) > user.phone_code_expires:
        user.phone_code = None
        user.phone_code_expires = None
        db.session.commit()
        return jsonify({"error": "Код истёк. Запросите новый."}), 400

    if code != user.phone_code:
        return jsonify({"error": "Неверный код"}), 401

    user.phone_verified = True
    user.phone_code = None
    user.phone_code_expires = None
    db.session.commit()
    return jsonify({"message": "Телефон подтверждён"}), 200


@auth_bp.route("/api/auth/phone/update", methods=["POST"])
@jwt_required()
def update_phone():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404

    data = request.get_json() or {}
    phone = data.get("phone", "").strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if not phone.startswith("+") or len(phone) < 10:
        return jsonify({"error": "Телефон должен быть в формате +71234567890"}), 400
    if User.query.filter(User.phone == phone, User.id != user_id).first():
        return jsonify({"error": "Телефон уже используется"}), 409

    user.phone = phone
    user.phone_verified = False
    user.phone_code = None
    user.phone_code_expires = None
    db.session.commit()

    # Auto-send code
    code = send_sms_code(phone)
    if not code:
        code = generate_sms_code()
        print(f"[DEV] SMS code for {phone}: {code}")
    user.phone_code = code
    user.phone_code_expires = datetime.now(timezone.utc) + timedelta(minutes=5)
    db.session.commit()

    return jsonify({"message": "Телефон обновлён. Код отправлен."}), 200

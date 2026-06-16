import os
import pyotp
import qrcode
import io
import base64
from flask import Flask, render_template, send_from_directory, jsonify, request
from flask_socketio import SocketIO
from flask_jwt_extended import JWTManager, jwt_required, get_jwt_identity
from flask_cors import CORS
import config
from models import db, User, Room, RoomMember, Message, Contact
from auth import auth_bp
from chat_events import register_socket_events
from rate_limiter import rate_limit
from datetime import datetime, timezone
from werkzeug.utils import secure_filename
import bcrypt

app = Flask(__name__,
    template_folder=os.path.join(config.RESOURCE_DIR, "templates"),
    static_folder=os.path.join(config.RESOURCE_DIR, "static"),
    static_url_path="/static")
app.config.from_object(config)
app.config["SECRET_KEY"] = config.SECRET_KEY

CORS(app, supports_credentials=True)
db.init_app(app)
jwt = JWTManager(app)

socketio = SocketIO(app, cors_allowed_origins="*", manage_session=False, async_mode='threading')

app.register_blueprint(auth_bp)
register_socket_events(socketio)


# --- Security headers ---
@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# --- Global rate limit ---
@app.before_request
@rate_limit(*config.RATE_LIMIT_GLOBAL)
def global_rate_limit():
    pass


@app.before_request
def create_tables():
    if not hasattr(app, "_tables_created"):
        with app.app_context():
            db.create_all()
        app._tables_created = True


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(config.UPLOAD_FOLDER, filename)


# --- Profile ---
@app.route("/api/profile", methods=["GET", "PUT"])
@jwt_required()
def profile():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404

    if request.method == "GET":
        return jsonify({"user": user.to_dict(full=True)}), 200

    data = request.get_json() or {}
    nickname = data.get("nickname", "").strip()
    if nickname:
        if len(nickname) < 2:
            return jsonify({"error": "Никнейм минимум 2 символа"}), 400
        user.nickname = nickname
    elif "nickname" in data:
        user.nickname = None

    bio = data.get("bio", "").strip()
    if "bio" in data:
        user.bio = bio if bio else None

    if "avatar" in data:
        user.avatar = data["avatar"]

    db.session.commit()
    return jsonify({"user": user.to_dict(full=True), "message": "Профиль обновлён"}), 200


# --- 2FA Setup ---
@app.route("/api/auth/2fa/setup", methods=["POST"])
@jwt_required()
def setup_2fa():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    if user.totp_enabled:
        return jsonify({"error": "2FA уже включена"}), 400

    secret = pyotp.random_base32()
    user.totp_secret = secret
    db.session.commit()

    issuer = "Eon Messenger"
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=user.username, issuer_name=issuer)

    # Generate QR as base64
    qr = qrcode.make(uri)
    buf = io.BytesIO()
    qr.save(buf, format="PNG")
    qr_b64 = base64.b64encode(buf.getvalue()).decode()

    return jsonify({
        "secret": secret,
        "uri": uri,
        "qr_base64": qr_b64,
    }), 200


@app.route("/api/auth/2fa/enable", methods=["POST"])
@jwt_required()
def enable_2fa():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user or not user.totp_secret:
        return jsonify({"error": "Сначала выполните setup"}), 400
    if user.totp_enabled:
        return jsonify({"error": "2FA уже включена"}), 400

    data = request.get_json() or {}
    code = data.get("code", "").strip()
    if not code:
        return jsonify({"error": "Введите код из приложения"}), 400

    totp = pyotp.TOTP(user.totp_secret)
    if not totp.verify(code, valid_window=1):
        return jsonify({"error": "Неверный код"}), 401

    user.totp_enabled = True
    db.session.commit()
    return jsonify({"message": "2FA включена"}), 200


@app.route("/api/auth/2fa/disable", methods=["POST"])
@jwt_required()
def disable_2fa():
    user_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Пользователь не найден"}), 404
    if not user.totp_enabled:
        return jsonify({"error": "2FA не включена"}), 400

    data = request.get_json() or {}
    password = data.get("password", "")
    if not bcrypt.checkpw(password.encode(), user.password_hash.encode()):
        return jsonify({"error": "Неверный пароль"}), 401

    user.totp_secret = None
    user.totp_enabled = False
    db.session.commit()
    return jsonify({"message": "2FA отключена"}), 200


# --- Conversations ---
@app.route("/api/conversations", methods=["GET"])
@jwt_required()
def get_conversations():
    user_id = int(get_jwt_identity())
    conversations = []

    memberships = RoomMember.query.filter_by(user_id=user_id).all()
    for m in memberships:
        room = db.session.get(Room, m.room_id)
        if not room:
            continue
        last = room.last_message()
        conversations.append({
            "type": room.type,
            "id": room.id,
            "name": room.name,
            "unread": 0,
            "last_message": last.to_dict() if last else None,
            "member_count": room.member_count(),
            "created_by": room.created_by,
        })

    dm_ids = set()
    sent = db.session.query(Message.recipient_id).filter(
        Message.sender_id == user_id, Message.recipient_id.isnot(None)
    ).distinct().all()
    received = db.session.query(Message.sender_id).filter(
        Message.recipient_id == user_id, Message.sender_id.isnot(None)
    ).distinct().all()
    for (rid,) in sent:
        dm_ids.add(rid)
    for (sid,) in received:
        dm_ids.add(sid)

    for dm_id in dm_ids:
        partner = db.session.get(User, dm_id)
        if not partner:
            continue
        contact = Contact.query.filter_by(user_id=user_id, contact_id=dm_id).first()
        conv_name = contact.label if contact and contact.label else partner.display_name()
        last = Message.query.filter(
            ((Message.sender_id == user_id) & (Message.recipient_id == dm_id)) |
            ((Message.sender_id == dm_id) & (Message.recipient_id == user_id))
        ).order_by(Message.created_at.desc()).first()
        conversations.append({
            "type": "private",
            "id": dm_id,
            "name": conv_name,
            "avatar": partner.avatar,
            "is_online": partner.is_online,
            "unread": 0,
            "last_message": last.to_dict() if last else None,
        })

    conversations.sort(key=lambda c: (c["last_message"] or {}).get("created_at", ""), reverse=True)
    return jsonify({"conversations": conversations}), 200


# --- Search users (by username/login for discovery, nickname in results) ---
@app.route("/api/users/search", methods=["GET"])
@jwt_required()
def search_users():
    q = request.args.get("q", "").strip()
    if not q or len(q) < 1:
        return jsonify({"users": []}), 200
    users = User.query.filter(
        (User.username.ilike(f"%{q}%")) | (User.nickname.ilike(f"%{q}%"))
    ).limit(20).all()
    return jsonify({"users": [u.to_dict() for u in users]}), 200


# --- Create group ---
@app.route("/api/groups", methods=["POST"])
@jwt_required()
def create_group():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    member_ids = data.get("member_ids", [])
    if not name:
        return jsonify({"error": "Название группы обязательно"}), 400
    if len(name) > 50:
        return jsonify({"error": "Название слишком длинное"}), 400
    user_id = int(get_jwt_identity())
    all_members = list(set(member_ids + [user_id]))
    room = Room(name=name, type="group", created_by=user_id)
    db.session.add(room)
    db.session.flush()
    for uid in all_members:
        db.session.add(RoomMember(room_id=room.id, user_id=uid))
    db.session.commit()
    return jsonify({"room": room.to_dict()}), 201


# --- Create channel ---
@app.route("/api/channels", methods=["POST"])
@jwt_required()
def create_channel():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Название канала обязательно"}), 400
    if len(name) > 50:
        return jsonify({"error": "Название слишком длинное"}), 400
    user_id = int(get_jwt_identity())
    room = Room(name=name, type="channel", created_by=user_id)
    db.session.add(room)
    db.session.flush()
    db.session.add(RoomMember(room_id=room.id, user_id=user_id))
    db.session.commit()
    return jsonify({"room": room.to_dict()}), 201


# --- Get/Update room (group/channel profile) ---
@app.route("/api/rooms/<int:room_id>", methods=["GET", "PUT"])
@jwt_required()
def room_detail(room_id):
    room = db.session.get(Room, room_id)
    if not room:
        return jsonify({"error": "Не найдено"}), 404
    if request.method == "GET":
        return jsonify({"room": room.to_dict()}), 200
    # PUT - update
    user_id = int(get_jwt_identity())
    if room.created_by != user_id:
        return jsonify({"error": "Только создатель может редактировать"}), 403
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if name:
        if len(name) > 50:
            return jsonify({"error": "Название слишком длинное"}), 400
        room.name = name
    if "description" in data:
        desc = data.get("description", "").strip()
        room.description = desc if desc else None
    if "avatar" in data:
        room.avatar = data["avatar"]
    db.session.commit()
    return jsonify({"room": room.to_dict(), "message": "Профиль обновлён"}), 200


# --- Join room ---
@app.route("/api/rooms/<int:room_id>/join", methods=["POST"])
@jwt_required()
def join_room(room_id):
    user_id = int(get_jwt_identity())
    room = db.session.get(Room, room_id)
    if not room:
        return jsonify({"error": "Не найдено"}), 404
    existing = RoomMember.query.filter_by(room_id=room_id, user_id=user_id).first()
    if not existing:
        db.session.add(RoomMember(room_id=room_id, user_id=user_id))
        db.session.commit()
    return jsonify({"message": "Подписка оформлена"}), 200


# --- Search rooms ---
@app.route("/api/rooms/search", methods=["GET"])
@jwt_required()
def search_rooms():
    q = request.args.get("q", "").strip()
    if not q or len(q) < 1:
        return jsonify({"rooms": []}), 200
    rooms = Room.query.filter(Room.name.ilike(f"%{q}%")).limit(20).all()
    return jsonify({"rooms": [r.to_dict() for r in rooms]}), 200


# --- Messages for room ---
@app.route("/api/rooms/<int:room_id>/messages", methods=["GET"])
@jwt_required()
def get_room_messages(room_id):
    page = request.args.get("page", 1, type=int)
    per_page = 100
    msgs = Message.query.filter_by(room_id=room_id).order_by(
        Message.created_at.desc()
    ).paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({
        "messages": [m.to_dict() for m in reversed(msgs.items)],
        "has_more": msgs.has_next,
    }), 200


# --- Private messages ---
@app.route("/api/private-messages/<int:user_id>", methods=["GET"])
@jwt_required()
def get_private_messages(user_id):
    current_user = int(get_jwt_identity())
    page = request.args.get("page", 1, type=int)
    per_page = 100
    msgs = Message.query.filter(
        ((Message.sender_id == current_user) & (Message.recipient_id == user_id)) |
        ((Message.sender_id == user_id) & (Message.recipient_id == current_user))
    ).order_by(Message.created_at.desc()).paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({
        "messages": [m.to_dict() for m in reversed(msgs.items)],
        "has_more": msgs.has_next,
    }), 200


# --- Delete message ---
@app.route("/api/messages/<int:message_id>", methods=["DELETE"])
@jwt_required()
def delete_message(message_id):
    user_id = int(get_jwt_identity())
    msg = db.session.get(Message, message_id)
    if not msg:
        return jsonify({"error": "Сообщение не найдено"}), 404
    if msg.sender_id != user_id:
        return jsonify({"error": "Не ваше сообщение"}), 403
    if msg.file_path:
        fp = os.path.join(config.UPLOAD_FOLDER, msg.file_path.replace("uploads/", ""))
        if os.path.exists(fp):
            os.remove(fp)
    db.session.delete(msg)
    db.session.commit()
    return jsonify({"message": "Удалено"}), 200


# --- Get user ---
@app.route("/api/users/<int:user_id>", methods=["GET"])
@jwt_required()
def get_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Не найден"}), 404
    return jsonify({"user": user.to_dict()}), 200


# --- File upload ---
ALLOWED_EXTENSIONS = {"webm", "ogg", "wav", "mp4", "mp3", "png", "jpg", "jpeg", "gif"}

def allowed_file(filename):
    if "." not in filename:
        return False
    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXTENSIONS and len(filename) < 256

@app.route("/api/upload", methods=["POST"])
@jwt_required()
def upload_file():
    if "file" not in request.files:
        return jsonify({"error": "Файл не прикреплён"}), 400
    file = request.files["file"]
    if file.filename == "" or not allowed_file(file.filename):
        return jsonify({"error": "Недопустимый файл"}), 400
    file_type = request.form.get("type", "voice")
    sub_map = {"voice": "voice", "video": "video", "photo": "photos", "avatar": "avatars"}
    sub = sub_map.get(file_type, "voice")
    path = os.path.join(config.UPLOAD_FOLDER, sub)
    os.makedirs(path, exist_ok=True)
    ts = datetime.now(timezone.utc).timestamp()
    safe_name = secure_filename(f"{ts}_{file.filename}")
    file.save(os.path.join(path, safe_name))
    return jsonify({"file_path": f"uploads/{sub}/{safe_name}"}), 200


# --- Contacts / Subscriptions ---
@app.route("/api/contacts", methods=["GET"])
@jwt_required()
def get_contacts():
    user_id = int(get_jwt_identity())
    contacts = Contact.query.filter_by(user_id=user_id).all()
    result = []
    for c in contacts:
        contact_user = db.session.get(User, c.contact_id)
        if contact_user:
            result.append({
                "id": c.id,
                "user_id": c.contact_id,
                "display_name": contact_user.display_name(),
                "avatar": contact_user.avatar,
                "is_online": contact_user.is_online,
                "subscribed": c.subscribed,
                "label": c.label,
                "created_at": c.created_at.isoformat() if c.created_at else None,
            })
    return jsonify({"contacts": result}), 200


@app.route("/api/contacts/add", methods=["POST"])
@jwt_required()
def add_contact():
    user_id = int(get_jwt_identity())
    data = request.get_json() or {}
    contact_id = data.get("contact_id")
    if not contact_id or contact_id == user_id:
        return jsonify({"error": "Некорректный пользователь"}), 400
    existing = Contact.query.filter_by(user_id=user_id, contact_id=contact_id).first()
    if existing:
        return jsonify({"message": "Уже в контактах"}), 200
    contact = Contact(user_id=user_id, contact_id=contact_id, subscribed=True)
    db.session.add(contact)
    db.session.commit()
    return jsonify({"message": "Пользователь добавлен в контакты"}), 201


@app.route("/api/contacts/<int:contact_id>/label", methods=["PUT"])
@jwt_required()
def update_contact_label(contact_id):
    user_id = int(get_jwt_identity())
    contact = Contact.query.filter_by(user_id=user_id, contact_id=contact_id).first()
    if not contact:
        return jsonify({"error": "Контакт не найден"}), 404
    data = request.get_json() or {}
    label = data.get("label", "").strip()
    contact.label = label if label else None
    db.session.commit()
    return jsonify({"message": "Метка обновлена"}), 200


@app.route("/api/contacts/subscribe", methods=["POST"])
@jwt_required()
def toggle_subscribe():
    user_id = int(get_jwt_identity())
    data = request.get_json() or {}
    contact_id = data.get("contact_id")
    subscribe = data.get("subscribe", True)
    if not contact_id:
        return jsonify({"error": "contact_id обязателен"}), 400
    contact = Contact.query.filter_by(user_id=user_id, contact_id=contact_id).first()
    if not contact:
        contact = Contact(user_id=user_id, contact_id=contact_id, subscribed=subscribe)
        db.session.add(contact)
    else:
        contact.subscribed = subscribe
    db.session.commit()
    return jsonify({"message": "Подписка обновлена"}), 200


# --- User profile (public) ---
@app.route("/api/users/<int:user_id>/profile", methods=["GET"])
@jwt_required()
def get_user_profile(user_id):
    current_id = int(get_jwt_identity())
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "Не найден"}), 404

    # Check if current user has this user in contacts
    contact = Contact.query.filter_by(user_id=current_id, contact_id=user_id).first()

    # Count subscribers
    subscriber_count = Contact.query.filter_by(contact_id=user_id, subscribed=True).count()

    # Subscriptions count
    subscription_count = Contact.query.filter_by(user_id=user_id, subscribed=True).count()

    return jsonify({
        "user": user.to_dict(),
        "is_contact": contact is not None,
        "is_subscribed": contact.subscribed if contact else False,
        "contact_label": contact.label if contact else None,
        "subscriber_count": subscriber_count,
        "subscription_count": subscription_count,
    }), 200


# --- Pages ---
@app.route("/")
def index():
    return render_template("login.html")

@app.route("/register")
def register_page():
    return render_template("register.html")

@app.route("/chat")
def chat_page():
    return render_template("chat.html")


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=8000, debug=True, allow_unsafe_werkzeug=True)

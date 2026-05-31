from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, timezone
import secrets

db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    nickname = db.Column(db.String(80), nullable=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    avatar = db.Column(db.String(256), default="default.png")
    is_online = db.Column(db.Boolean, default=False)
    last_seen = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # 2FA
    totp_secret = db.Column(db.String(64), nullable=True)
    totp_enabled = db.Column(db.Boolean, default=False)

    # Email verification
    is_verified = db.Column(db.Boolean, default=False)
    verification_token = db.Column(db.String(128), nullable=True, unique=True)

    # Bio
    bio = db.Column(db.String(500), nullable=True)

    sent_messages = db.relationship("Message", foreign_keys="Message.sender_id", backref="sender", lazy="dynamic")
    room_memberships = db.relationship("RoomMember", backref="user", lazy="dynamic")

    def display_name(self):
        return self.nickname or self.username

    def to_dict(self, full=False):
        data = {
            "id": self.id,
            "nickname": self.nickname,
            "display_name": self.display_name(),
            "avatar": self.avatar,
            "is_online": self.is_online,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "bio": self.bio,
        }
        if full:
            data.update({
                "username": self.username,
                "email": self.email,
                "is_verified": self.is_verified,
                "totp_enabled": self.totp_enabled,
            })
        return data

    @staticmethod
    def generate_verification_token():
        return secrets.token_urlsafe(48)


class Room(db.Model):
    __tablename__ = "rooms"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    type = db.Column(db.String(20), default="group")
    is_private = db.Column(db.Boolean, default=False)
    description = db.Column(db.String(500), nullable=True)
    avatar = db.Column(db.String(256), nullable=True)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    members = db.relationship("RoomMember", backref="room", lazy="dynamic")
    messages = db.relationship("Message", foreign_keys="Message.room_id", backref="room", lazy="dynamic")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "is_private": self.is_private,
            "description": self.description,
            "avatar": self.avatar,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

    def last_message(self):
        return Message.query.filter_by(room_id=self.id).order_by(Message.created_at.desc()).first()

    def member_count(self):
        return RoomMember.query.filter_by(room_id=self.id).count()


class RoomMember(db.Model):
    __tablename__ = "room_members"
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    joined_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


class Contact(db.Model):
    __tablename__ = "contacts"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    contact_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    subscribed = db.Column(db.Boolean, default=False)
    label = db.Column(db.String(80), nullable=True)  # custom nickname visible only to user_id
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


class Message(db.Model):
    __tablename__ = "messages"
    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    room_id = db.Column(db.Integer, db.ForeignKey("rooms.id"), nullable=True)
    recipient_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    content = db.Column(db.Text, nullable=True)
    message_type = db.Column(db.String(20), default="text")
    file_path = db.Column(db.String(256), nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    recipient = db.relationship("User", foreign_keys=[recipient_id], backref="received_messages")

    def to_dict(self):
        return {
            "id": self.id,
            "sender_id": self.sender_id,
            "sender_username": self.sender.display_name() if self.sender else "Unknown",
            "room_id": self.room_id,
            "recipient_id": self.recipient_id,
            "content": self.content,
            "message_type": self.message_type,
            "file_path": self.file_path,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

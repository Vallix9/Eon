from flask import request
from flask_socketio import join_room, leave_room, emit
from flask_jwt_extended import decode_token
from models import db, User, Message, Room, RoomMember
from datetime import datetime, timezone
import time as time_module

connected_users = {}  # sid -> user_id
_message_ratelimit = {}  # user_id -> [timestamps]


def _check_ratelimit(user_id, max_msgs=10, window=5):
    """Allow max_msgs per window seconds per user."""
    now = time_module.time()
    ts_list = _message_ratelimit.get(user_id, [])
    ts_list = [t for t in ts_list if now - t < window]
    if len(ts_list) >= max_msgs:
        return False
    ts_list.append(now)
    _message_ratelimit[user_id] = ts_list
    return True


def register_socket_events(socketio):

    @socketio.on("connect")
    def handle_connect():
        token = request.args.get("token")
        if not token:
            return False
        try:
            data = decode_token(token)
            user_id = int(data["sub"])
            user = db.session.get(User, user_id)
            if not user:
                return False
            # Remove any stale sid for this user
            stale_sids = [sid for sid, uid in connected_users.items() if uid == user_id]
            for sid in stale_sids:
                connected_users.pop(sid, None)
            user.is_online = True
            user.last_seen = datetime.now(timezone.utc)
            connected_users[request.sid] = user_id
            db.session.commit()
        except Exception:
            db.session.rollback()
            return False
        finally:
            db.session.remove()
        try:
            emit("user_status", {"user_id": user_id, "is_online": True}, broadcast=True)
        except Exception:
            pass
        return True

    @socketio.on("disconnect")
    def handle_disconnect():
        user_id = connected_users.pop(request.sid, None)
        if user_id:
            try:
                user = db.session.get(User, user_id)
                if user:
                    user.is_online = False
                    user.last_seen = datetime.now(timezone.utc)
                    db.session.commit()
                    emit("user_status", {"user_id": user_id, "is_online": False}, broadcast=True)
            except Exception:
                db.session.rollback()
            finally:
                db.session.remove()

    @socketio.on("join_room")
    def handle_join_room(data):
        room_id = data.get("room_id")
        user_id = connected_users.get(request.sid)
        if not user_id or not room_id:
            return
        join_room(str(room_id))
        # Load recent messages
        messages = Message.query.filter_by(room_id=room_id).order_by(Message.created_at.asc()).limit(100).all()
        emit("load_messages", [m.to_dict() for m in messages], to=request.sid)

    @socketio.on("leave_room")
    def handle_leave_room(data):
        room_id = data.get("room_id")
        if room_id:
            leave_room(str(room_id))

    def can_send_in_room(user_id, room_id):
        room = db.session.get(Room, room_id)
        if not room:
            return False
        if room.type == "channel" and room.created_by != user_id:
            return False
        is_member = RoomMember.query.filter_by(room_id=room_id, user_id=user_id).first()
        if not is_member:
            return False
        return True

    @socketio.on("send_message")
    def handle_send_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        if not _check_ratelimit(user_id):
            emit("error", {"message": "Слишком много сообщений. Подождите."})
            return
        room_id = data.get("room_id")
        content = data.get("content", "").strip()
        if not content or not room_id:
            return
        if not can_send_in_room(user_id, room_id):
            emit("error", {"message": "Только создатель канала может отправлять сообщения"})
            return

        msg = Message(
            sender_id=user_id,
            room_id=room_id,
            content=content,
            message_type="text",
            created_at=datetime.now(timezone.utc),
        )
        db.session.add(msg)
        db.session.commit()
        msg_data = msg.to_dict()
        emit("new_message", msg_data, to=str(room_id))

    @socketio.on("send_private_message")
    def handle_private_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        if not _check_ratelimit(user_id):
            emit("error", {"message": "Слишком много сообщений. Подождите."})
            return
        recipient_id = data.get("recipient_id")
        content = data.get("content", "").strip()
        if not content or not recipient_id:
            return

        msg = Message(
            sender_id=user_id,
            recipient_id=recipient_id,
            content=content,
            message_type="text",
            created_at=datetime.now(timezone.utc),
        )
        db.session.add(msg)
        db.session.commit()
        msg_data = msg.to_dict()
        # Send to sender
        emit("new_private_message", msg_data, to=request.sid)
        # Send to recipient if online
        for sid, uid in connected_users.items():
            if uid == recipient_id:
                emit("new_private_message", msg_data, to=sid)

    @socketio.on("send_voice_message")
    def handle_voice_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        if not _check_ratelimit(user_id):
            emit("error", {"message": "Слишком много сообщений. Подождите."})
            return
        room_id = data.get("room_id")
        recipient_id = data.get("recipient_id")
        file_path = data.get("file_path")
        if not file_path:
            return
        if room_id and not can_send_in_room(user_id, room_id):
            emit("error", {"message": "Только создатель канала может отправлять сообщения"})
            return

        msg = Message(
            sender_id=user_id,
            room_id=room_id,
            recipient_id=recipient_id,
            message_type="voice",
            file_path=file_path,
            created_at=datetime.now(timezone.utc),
        )
        db.session.add(msg)
        db.session.commit()
        msg_data = msg.to_dict()
        if room_id:
            emit("new_message", msg_data, to=str(room_id))
        elif recipient_id:
            emit("new_private_message", msg_data, to=request.sid)
            for sid, uid in connected_users.items():
                if uid == recipient_id:
                    emit("new_private_message", msg_data, to=sid)

    @socketio.on("send_video_message")
    def handle_video_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        if not _check_ratelimit(user_id):
            emit("error", {"message": "Слишком много сообщений. Подождите."})
            return
        room_id = data.get("room_id")
        recipient_id = data.get("recipient_id")
        file_path = data.get("file_path")
        if not file_path:
            return
        if room_id and not can_send_in_room(user_id, room_id):
            emit("error", {"message": "Только создатель канала может отправлять сообщения"})
            return

        msg = Message(
            sender_id=user_id,
            room_id=room_id,
            recipient_id=recipient_id,
            message_type="video",
            file_path=file_path,
            created_at=datetime.now(timezone.utc),
        )
        db.session.add(msg)
        db.session.commit()
        msg_data = msg.to_dict()
        if room_id:
            emit("new_message", msg_data, to=str(room_id))
        elif recipient_id:
            emit("new_private_message", msg_data, to=request.sid)
            for sid, uid in connected_users.items():
                if uid == recipient_id:
                    emit("new_private_message", msg_data, to=sid)

    @socketio.on("typing")
    def handle_typing(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        room_id = data.get("room_id")
        recipient_id = data.get("recipient_id")
        user = db.session.get(User, user_id)
        username = user.display_name() if user else "Unknown"
        payload = {"user_id": user_id, "username": username, "is_typing": data.get("is_typing", False)}
        if room_id:
            emit("typing_indicator", payload, to=str(room_id))
        elif recipient_id:
            for sid, uid in connected_users.items():
                if uid == recipient_id:
                    emit("typing_indicator", payload, to=sid)

    @socketio.on("send_media_message")
    def handle_media_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        if not _check_ratelimit(user_id):
            emit("error", {"message": "Слишком много сообщений. Подождите."})
            return
        room_id = data.get("room_id")
        recipient_id = data.get("recipient_id")
        file_path = data.get("file_path")
        msg_type = data.get("media_type", "photo")
        if not file_path:
            return
        if room_id and not can_send_in_room(user_id, room_id):
            emit("error", {"message": "Только создатель канала может отправлять сообщения"})
            return

        msg = Message(
            sender_id=user_id,
            room_id=room_id,
            recipient_id=recipient_id,
            message_type=msg_type,
            file_path=file_path,
            created_at=datetime.now(timezone.utc),
        )
        db.session.add(msg)
        db.session.commit()
        msg_data = msg.to_dict()
        if room_id:
            emit("new_message", msg_data, to=str(room_id))
        elif recipient_id:
            emit("new_private_message", msg_data, to=request.sid)
            for sid, uid in connected_users.items():
                if uid == recipient_id:
                    emit("new_private_message", msg_data, to=sid)

    @socketio.on("delete_message")
    def handle_delete_message(data):
        user_id = connected_users.get(request.sid)
        if not user_id:
            return
        message_id = data.get("message_id")
        room_id = data.get("room_id")
        if not message_id:
            return
        payload = {"message_id": message_id}
        if room_id:
            emit("message_deleted", payload, to=str(room_id))
        else:
            # Private message — only notify sender and recipient
            msg = db.session.get(Message, message_id)
            if msg:
                emit("message_deleted", payload, to=request.sid)
                for sid, uid in connected_users.items():
                    if uid == msg.recipient_id:
                        emit("message_deleted", payload, to=sid)

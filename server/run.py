import os
import sys
import threading
import time
import urllib.request
import logging
import socket as sock

import webview

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
from app import socketio, app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    filename=os.path.join(config.BASE_DIR, "eon.log"),
    filemode="a",
)
log = logging.getLogger("eon")


class Api:
    pass


def port_in_use(port, host="127.0.0.1"):
    with sock.socket(sock.AF_INET, sock.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) == 0


def wait_for_server(url, timeout=15):
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def start_server():
    log.info("Starting Flask/SocketIO server...")
    try:
        socketio.run(app, host="0.0.0.0", port=8000, debug=False, allow_unsafe_werkzeug=True)
    except Exception as e:
        log.error(f"Server failed: {e}")


if __name__ == "__main__":
    if port_in_use(8000):
        log.warning("Port 8000 is already in use. Waiting for it to become available...")
        for _ in range(10):
            time.sleep(1)
            if not port_in_use(8000):
                break
        else:
            log.error("Port 8000 still in use. Is another instance running?")
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, "Порт 8000 уже занят. Закройте другой экземпляр Eon Messenger.", "Ошибка", 0)
            sys.exit(1)

    t = threading.Thread(target=start_server, daemon=True)
    t.start()

    log.info("Waiting for server...")
    if not wait_for_server("http://127.0.0.1:8000/"):
        log.error("Server failed to start")
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, "Не удалось запустить сервер. Проверьте eon.log.", "Ошибка", 0)
        sys.exit(1)
    log.info("Server is ready")

    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "img", "icon.ico")
    if not os.path.exists(icon_path):
        icon_path = None

    webview.create_window(
        "Eon Messenger",
        "http://127.0.0.1:8000",
        width=1200,
        height=800,
        min_size=(800, 600),
        text_select=True,
        js_api=Api(),
    )
    webview.start(icon=icon_path, private_mode=False)

import os
import sys
import threading
import time
import urllib.request
import logging

import webview

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import socketio, app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    filename=os.path.join(os.path.dirname(os.path.abspath(__file__)), "eon.log"),
    filemode="a",
)
log = logging.getLogger("eon")


def wait_for_server(url, timeout=10):
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
    socketio.run(app, host="127.0.0.1", port=8000, debug=False, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    t = threading.Thread(target=start_server, daemon=True)
    t.start()

    log.info("Waiting for server...")
    if not wait_for_server("http://127.0.0.1:8000/"):
        log.error("Server failed to start")
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
    )
    webview.start(icon=icon_path, private_mode=False)

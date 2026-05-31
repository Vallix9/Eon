import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import socketio, app
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=8000, debug=False, allow_unsafe_werkzeug=True)

# Eon Messenger

Real-time messenger with Flask backend and desktop/mobile clients.

## Architecture

- **Server** — Flask + Socket.IO (Python), SQLite database
- **Desktop** — pywebview wrapper (Windows .exe)
- **Mobile** — Capacitor (Android), Flutter (planned)

## Quick Start

```bash
cd server
pip install -r requirements.txt
python app.py
```

Open http://localhost:8000 in a browser.

## Build Desktop .exe

```bash
cd server
pip install pyinstaller
pyinstaller --onefile --windowed --add-data "templates;templates" --add-data "static;static" --add-data "config.py;." --name "EonMessenger" run.py
```

## Features

- Private messages, groups, channels
- Voice and video messages
- File sharing (images, video)
- 2FA authentication
- Dark/light theme
- PWA support (mobile browser install)

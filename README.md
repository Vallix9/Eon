# Eon Messenger

Real-time messenger with Flask backend and desktop/mobile clients.

## Architecture

- **`server/`** — Flask + Socket.IO (Python), SQLite database
- **`desktop/`** — pywebview wrapper (Windows .exe)
- **`mobile/`** — Capacitor (Android), Flutter (planned)
- **`flutter_app/`** — Future Flutter project (placeholder)

## Quick Start

### Start the server

```bash
cd server
pip install -r requirements.txt
python run_server.py
```

Open http://localhost:8000 in a browser.

### Run the desktop client (separate terminal)

```bash
cd desktop
pip install pywebview
python main.py
```

Override the server URL: `python main.py http://localhost:8000`

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

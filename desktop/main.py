import os
import sys
import json
import webview

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

def load_config():
    default = {"server_url": "http://localhost:8000"}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                return {**default, **json.load(f)}
        except:
            pass
    return default

def save_config(config):
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f)

if __name__ == "__main__":
    config = load_config()
    url = sys.argv[1] if len(sys.argv) > 1 else config["server_url"]
    config["server_url"] = url
    save_config(config)

    webview.create_window("Eon Messenger", url, width=1200, height=800, min_size=(800, 600), text_select=True)
    webview.start(private_mode=False)

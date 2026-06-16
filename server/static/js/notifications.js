class ChatNotifications {
    constructor() {
        this._cap = null;
        this._webOk = null;
    }

    async _init() {
        if (this._cap !== null) return;
        // check Capacitor LocalNotifications
        try {
            const p = window.Capacitor?.Plugins?.LocalNotifications;
            if (p) {
                const perm = await p.requestPermissions();
                if (perm?.display === "granted") { this._cap = p; return; }
            }
        } catch (_) {}
        // fallback: Web Notification API
        if ("Notification" in window) {
            if (Notification.permission === "granted") { this._webOk = true; return; }
            if (Notification.permission === "denied") { this._webOk = false; return; }
            try {
                const r = await Notification.requestPermission();
                this._webOk = r === "granted";
                return;
            } catch (_) {}
        }
        this._webOk = false;
    }

    async notify(title, body, options = {}) {
        await this._init();
        try {
            if (this._cap) {
                await this._cap.schedule({
                    notifications: [{
                        id: Date.now(),
                        title,
                        body: body || "",
                        smallIcon: "ic_stat_icon",
                        largeIcon: "res://drawable/icon",
                        ...options
                    }]
                });
                return;
            }
            if (this._webOk) {
                new Notification(title, { body, icon: "/static/img/icon-192.png", ...options });
                return;
            }
        } catch (_) {}
        this._toast(title, body);
    }

    _toast(title, body) {
        const el = document.getElementById("notif-toast");
        if (el) el.remove();
        const t = document.createElement("div");
        t.id = "notif-toast";
        t.innerHTML = `<strong>${this._esc(title)}</strong><br><span>${this._esc(body || "")}</span>`;
        Object.assign(t.style, {
            position:"fixed", bottom:"80px", left:"50%", transform:"translateX(-50%)",
            background:"var(--bg-sidebar)", color:"var(--text)", padding:"10px 16px",
            borderRadius:"var(--radius-lg)", boxShadow:"0 4px 20px rgba(0,0,0,.4)",
            zIndex:"999", fontSize:"13px", maxWidth:"300px", textAlign:"center",
            border:"1px solid var(--border)", opacity:"0", transition:"opacity .3s ease"
        });
        document.body.appendChild(t);
        requestAnimationFrame(() => { t.style.opacity = "1"; });
        setTimeout(() => {
            t.style.opacity = "0";
            setTimeout(() => t.remove(), 300);
        }, 3000);
    }

    _esc(s) {
        const d = document.createElement("div");
        d.textContent = s || "";
        return d.innerHTML;
    }

    playSound(type = "message") {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            gain.gain.value = 0.1;
            if (type === "message") {
                osc.frequency.value = 880;
                osc.start();
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
                osc.stop(ctx.currentTime + 0.15);
            } else if (type === "online") {
                osc.frequency.value = 660;
                osc.start();
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
                osc.stop(ctx.currentTime + 0.1);
            }
        } catch (_) {}
    }
}

const chatNotifications = new ChatNotifications();
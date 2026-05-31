class ChatNotifications {
    constructor() {
        this.enabled = false;
        this.requestPermission();
    }

    async requestPermission() {
        if (!("Notification" in window)) return;
        if (Notification.permission === "granted") {
            this.enabled = true;
        } else if (Notification.permission !== "denied") {
            const perm = await Notification.requestPermission();
            this.enabled = perm === "granted";
        }
    }

    notify(title, body, options = {}) {
        if (!this.enabled) return;
        try {
            new Notification(title, { body, icon: "/static/favicon.ico", ...options });
        } catch (e) {
            // fallback — ignore
        }
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
        } catch (e) {
            // audio not supported
        }
    }
}

const chatNotifications = new ChatNotifications();

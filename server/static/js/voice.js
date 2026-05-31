class VoiceRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.stream = null;
        this.startTime = 0;
        this.timerInterval = null;
        this.analyserNode = null;
        this.recordedBlob = null;
        this.onComplete = null;

        this.btn = document.getElementById("voice-btn");
        this.preview = document.getElementById("recording-preview");
        this.timer = document.getElementById("recording-timer");
        this.waveEl = document.getElementById("recording-wave");
        this.cancelBtn = document.getElementById("cancel-recording-btn");
        this.sendBtn = document.getElementById("send-recording-btn");

        if (this.btn) {
            this.btn.addEventListener("click", () => this.toggleRecording());
            this.cancelBtn.addEventListener("click", () => this.cancel());
            this.sendBtn.addEventListener("click", () => this.send());
        }
    }

    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            if (!window.MediaRecorder) {
                alert("Запись голоса не поддерживается в вашем браузере. Пожалуйста, используйте Chrome или Firefox на ПК.");
                return;
            }
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
            this.audioChunks = [];
            this.recordedBlob = null;
            this.isRecording = true;
            this.startTime = Date.now();

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.audioChunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => {
                this.recordedBlob = new Blob(this.audioChunks, { type: "audio/webm" });
            };

            this.mediaRecorder.start();
            this.btn.innerHTML = '<img src="/static/img/close.png" alt="Стоп" class="btn-img">';
            this.btn.style.color = "var(--danger)";
            this.preview.classList.remove("hidden");
            this.startTimer();
            this.setupVisualizer();
        } catch (err) {
            console.error("Voice recording error:", err);
            alert("Не удалось получить доступ к микрофону");
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            this.mediaRecorder.stop();
        }
        this.isRecording = false;
        clearInterval(this.timerInterval);
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        this.btn.innerHTML = '<img src="/static/img/voice.png" alt="Голос" class="btn-img">';
        this.btn.style.color = "";
    }

    cleanup() {
        this.isRecording = false;
        clearInterval(this.timerInterval);
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        this.btn.innerHTML = '<img src="/static/img/voice.png" alt="Голос" class="btn-img">';
        this.btn.style.color = "";
        this.preview.classList.add("hidden");
        this.timer.textContent = "0:00";
        this.waveEl.innerHTML = "";
        this.recordedBlob = null;
    }

    cancel() {
        this.audioChunks = [];
        this.cleanup();
    }

    send() {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.audioChunks, { type: "audio/webm" });
                const callback = this.onComplete;
                this.audioChunks = [];
                this.cleanup();
                if (callback) callback(blob);
            };
            this.mediaRecorder.stop();
        } else if (this.recordedBlob) {
            const blob = this.recordedBlob;
            const callback = this.onComplete;
            this.cleanup();
            if (callback) callback(blob);
        }
    }

    startTimer() {
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const min = String(Math.floor(elapsed / 60)).padStart(2, "0");
            const sec = String(elapsed % 60).padStart(2, "0");
            this.timer.textContent = `${min}:${sec}`;
            if (elapsed >= 180) this.stopRecording();
        }, 200);
    }

    setupVisualizer() {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(this.stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 64;
            source.connect(analyser);
            this.analyserNode = analyser;
            this.visualize();
        } catch (e) { /* viz not supported */ }
    }

    visualize() {
        if (!this.isRecording || !this.analyserNode) return;
        const canvas = document.createElement("canvas");
        canvas.width = 120;
        canvas.height = 30;
        this.waveEl.innerHTML = "";
        this.waveEl.appendChild(canvas);
        const ctx = canvas.getContext("2d");
        const bufferLength = this.analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            if (!this.isRecording) return;
            requestAnimationFrame(draw);
            this.analyserNode.getByteFrequencyData(dataArray);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const barWidth = (canvas.width / bufferLength) * 2.5;
            dataArray.forEach((value, i) => {
                const barHeight = (value / 255) * canvas.height;
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#667eea";
                ctx.fillRect(i * barWidth, canvas.height - barHeight, barWidth - 1, barHeight);
            });
        };
        draw();
    }
}

const voiceRecorder = new VoiceRecorder();

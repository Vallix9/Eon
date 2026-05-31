class VideoRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.videoChunks = [];
        this.isRecording = false;
        this.stream = null;
        this.startTime = 0;
        this.timerInterval = null;
        this.recordedBlob = null;
        this.onComplete = null;

        this.btn = document.getElementById("video-btn");
        this.container = document.getElementById("video-preview-container");
        this.preview = document.getElementById("video-preview");
        this.timer = document.getElementById("video-timer");
        this.cancelBtn = document.getElementById("cancel-video-btn");
        this.sendBtn = document.getElementById("send-video-btn");

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
                alert("Запись видео не поддерживается в вашем браузере. Пожалуйста, используйте Chrome или Firefox на ПК.");
                return;
            }
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: { width: { ideal: 360 }, height: { ideal: 360 }, facingMode: "user" },
            });

            this.preview.srcObject = this.stream;
            await this.preview.play();

            const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
                ? "video/webm;codecs=vp9"
                : "video/webm";
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
            this.videoChunks = [];
            this.recordedBlob = null;
            this.isRecording = true;
            this.startTime = Date.now();

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.videoChunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => {
                this.recordedBlob = new Blob(this.videoChunks, { type: "video/webm" });
            };

            this.mediaRecorder.start();
            this.btn.innerHTML = '<img src="/static/img/close.png" alt="Стоп" class="btn-img">';
            this.btn.style.color = "var(--danger)";
            this.container.classList.remove("hidden");
            this.startTimer();
        } catch (err) {
            console.error("Video recording error:", err);
            alert("Не удалось получить доступ к камере");
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
        this.btn.innerHTML = '<img src="/static/img/video.png" alt="Видео" class="btn-img">';
        this.btn.style.color = "";
    }

    cleanup() {
        this.isRecording = false;
        clearInterval(this.timerInterval);
        if (this.stream) {
            this.stream.getTracks().forEach((t) => t.stop());
            this.stream = null;
        }
        this.btn.innerHTML = '<img src="/static/img/video.png" alt="Видео" class="btn-img">';
        this.btn.style.color = "";
        this.container.classList.add("hidden");
        this.timer.textContent = "0:00";
        this.preview.srcObject = null;
        this.recordedBlob = null;
    }

    cancel() {
        this.videoChunks = [];
        this.cleanup();
    }

    send() {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.videoChunks, { type: "video/webm" });
                const callback = this.onComplete;
                this.videoChunks = [];
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
            if (elapsed >= 60) this.stopRecording();
        }, 200);
    }
}

const videoRecorder = new VideoRecorder();

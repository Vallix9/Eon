let socket = null;
let currentUser = null;
let currentChat = null;
let activeUsers = {};
let conversations = [];
let typingTimeout = null;
let unreadCounts = {};
let currentTheme = localStorage.getItem("ppchat_theme") || "dark";
let touchStartX = 0;
let pendingDeleteMsgId = null;
let searchTimeout = null;
let contactLabels = {};

document.addEventListener("DOMContentLoaded", async () => {
    if (!document.getElementById("chat-area")) return;
    const token = getToken();
    if (!token) { window.location.href = "/"; return; }

    applyTheme(currentTheme);

    try {
        const resp = await apiFetch("/api/auth/me");
        const data = await resp.json();
        if (!resp.ok) { clearToken(); window.location.href = "/"; return; }
        currentUser = data.user;
        document.getElementById("my-username").textContent = currentUser.display_name || currentUser.username;
    } catch (e) { window.location.href = "/"; return; }

    connectSocket();
    await loadConversations();
    setupEventListeners();
});

// --- Theme ---
function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ppchat_theme", theme);
    document.querySelectorAll(".theme-option").forEach((el) => {
        el.classList.toggle("active", el.dataset.theme === theme);
    });
}

// --- Socket ---
function connectSocket() {
    socket = io(API_BASE, { query: { token: getToken() } });

    socket.on("connect_error", () => console.error("Socket error"));

    socket.on("user_status", (data) => {
        activeUsers[data.user_id] = data.is_online;
        updateConvOnlineStatus(data.user_id, data.is_online);
        if (data.is_online && currentUser && data.user_id !== currentUser.id) {
            chatNotifications.playSound("online");
        }
    });

    socket.on("load_messages", (messages) => {
        document.getElementById("messages-list").innerHTML = "";
        messages.forEach((m) => renderMessage(m));
        scrollToBottom();
    });

    socket.on("new_message", (msg) => {
        if (currentChat && currentChat.type !== "private" && currentChat.id === msg.room_id) {
            renderMessage(msg);
            if (isNearBottom()) scrollToBottom();
        } else {
            incrementUnread(msg.room_id, msg.sender_id);
        }
        showNotification(msg);
        refreshConversations();
    });

    socket.on("new_private_message", (msg) => {
        const rel = currentChat && currentChat.type === "private" &&
            (msg.sender_id === currentChat.id || msg.recipient_id === currentChat.id);
        if (rel) {
            renderMessage(msg);
            if (isNearBottom()) scrollToBottom();
        } else if (msg.sender_id !== currentUser.id) {
            incrementUnread(null, msg.sender_id);
        }
        if (msg.sender_id !== currentUser.id) {
            chatNotifications.notify(msg.sender_username, msg.content || "Медиа");
            chatNotifications.playSound("message");
        }
        refreshConversations();
    });

    socket.on("typing_indicator", (data) => {
        if (data.user_id === currentUser.id) return;
        const el = document.getElementById("typing-indicator");
        el.textContent = data.is_typing ? `${data.username} печатает...` : "";
        el.classList.toggle("hidden", !data.is_typing);
    });

    socket.on("message_deleted", (data) => {
        const el = document.querySelector(`.message[data-msg-id="${data.message_id}"]`);
        if (el) el.remove();
        refreshConversations();
    });
}

// --- Conversations ---
async function loadConversations() {
    try {
        const [convResp, contactsResp] = await Promise.all([
            apiFetch("/api/conversations"),
            apiFetch("/api/contacts"),
        ]);
        const convData = await convResp.json();
        const contactsData = await contactsResp.json();
        conversations = convData.conversations;
        // Populate contact labels cache from contacts API (one call)
        if (contactsData.contacts) {
            contactsData.contacts.forEach((ct) => {
                if (ct.label) {
                    contactLabels[ct.user_id] = ct.label;
                }
            });
        }
        renderConversations();
    } catch (e) { console.error("Failed to load conversations", e); }
}

function refreshConversations() {
    return loadConversations();
}

function renderConversations() {
    const list = document.getElementById("chat-list");
    list.innerHTML = "";
    conversations.forEach((conv) => {
        const div = document.createElement("div");
        div.className = "chat-item";
        div.dataset.type = conv.type;
        div.dataset.id = conv.id;

        const isActive = currentChat && currentChat.type === conv.type && currentChat.id === conv.id;
        if (isActive) div.classList.add("active");

        // Avatar
        let avatarHtml = "";
        if (conv.type === "private") {
            const isOnline = activeUsers[conv.id] !== undefined ? activeUsers[conv.id] : conv.is_online;
            if (conv.avatar && conv.avatar !== "default.png") {
                avatarHtml = `<div class="chat-avatar private" style="background-image:url('/${conv.avatar}');background-size:cover;background-position:center;border:2px solid ${isOnline ? 'var(--success)' : 'var(--text-muted)'};background-color:transparent;"></div>`;
            } else {
                const initial = (conv.name || "?").charAt(0).toUpperCase();
                avatarHtml = `<div class="chat-avatar private" style="background:${isOnline ? 'var(--success)' : 'var(--text-muted)'}">${initial}</div>`;
            }
        } else if (conv.type === "channel") {
            avatarHtml = `<div class="chat-avatar channel"><img src="/static/img/channel.png" alt="" class="btn-img"></div>`;
        } else {
            avatarHtml = `<div class="chat-avatar group"><img src="/static/img/group.png" alt="" class="btn-img"></div>`;
        }

        // Last message preview
        const last = conv.last_message;
        let preview = "";
        if (last) {
            if (last.message_type === "text") preview = last.content;
            else if (last.message_type === "voice") preview = "🎤 Голосовое сообщение";
            else if (last.message_type === "video") preview = "📹 Видеосообщение";
            else if (last.message_type === "photo") preview = "📷 Фото";
            else if (last.message_type === "image") preview = "📷 Фото";
        }

        // Time
        let timeStr = "";
        if (last) {
            const d = new Date(last.created_at);
            const now = new Date();
            const sameDay = d.toDateString() === now.toDateString();
            timeStr = sameDay
                ? d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
                : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
        }

        // Unread
        const key = `${conv.type}_${conv.id}`;
        const unread = unreadCounts[key] || 0;
        const badgeHtml = unread > 0 ? `<span class="chat-badge">${unread}</span>` : "";

        div.innerHTML = `
            ${avatarHtml}
            <div class="chat-info">
                <div class="chat-name">${escapeHtml(conv.name)}</div>
                <div class="chat-preview">${escapeHtml(preview)}</div>
            </div>
            <div class="chat-meta">
                <span class="chat-time">${timeStr}</span>
                ${badgeHtml}
            </div>
        `;

        div.addEventListener("click", () => selectChat(conv));
        if (conv.type === "private") {
            div.addEventListener("contextmenu", (e) => { e.preventDefault(); viewUserProfile(conv.id); });
        }
        list.appendChild(div);
    });
}

function updateConvOnlineStatus(userId, isOnline) {
    document.querySelectorAll('.chat-item[data-type="private"]').forEach((el) => {
        if (parseInt(el.dataset.id) === userId) {
            const avatar = el.querySelector(".chat-avatar");
            if (avatar) avatar.style.background = isOnline ? "var(--success)" : "var(--text-muted)";
        }
    });
}

// --- Unread ---
function incrementUnread(roomId, senderId) {
    let key = null;
    if (roomId) {
        const conv = conversations.find((c) => c.type !== "private" && c.id === roomId);
        if (conv) key = `${conv.type}_${conv.id}`;
    } else if (senderId && senderId !== currentUser.id) {
        key = `private_${senderId}`;
    }
    if (key) {
        unreadCounts[key] = (unreadCounts[key] || 0) + 1;
        renderConversations();
    }
}

function clearUnread(type, id) {
    const key = `${type}_${id}`;
    delete unreadCounts[key];
    renderConversations();
}

// --- Select chat ---
function selectChat(conv) {
    if (currentChat) {
        if (currentChat.type !== "private") {
            socket.emit("leave_room", { room_id: currentChat.id });
        }
    }
    currentChat = { type: conv.type, id: conv.id, name: conv.name };
    clearUnread(conv.type, conv.id);

    document.getElementById("messages-list").innerHTML = "";
    document.getElementById("typing-indicator").classList.add("hidden");
    document.getElementById("chat-title").textContent = escapeHtml(conv.name);

    // Avatar in header
    const headerAvatar = document.getElementById("chat-header-avatar");
    headerAvatar.classList.remove("hidden");
    if (conv.avatar && conv.avatar !== "default.png") {
        headerAvatar.style.backgroundImage = `url('/${conv.avatar}')`;
        headerAvatar.style.backgroundSize = "cover";
        headerAvatar.style.backgroundPosition = "center";
        headerAvatar.textContent = "";
    } else {
        headerAvatar.style.backgroundImage = "none";
        const initial = (conv.name || "?").charAt(0).toUpperCase();
        headerAvatar.textContent = initial;
    }
    if (conv.type === "private") {
        headerAvatar.onclick = () => viewUserProfile(conv.id);
    } else {
        headerAvatar.onclick = null;
    }

    let statusText = "";
    if (conv.type === "private") {
        const online = activeUsers[conv.id] !== undefined ? activeUsers[conv.id] : conv.is_online;
        statusText = online ? "в сети" : "был(а) недавно";
    } else if (conv.type === "channel") {
        statusText = "Канал";
    } else {
        statusText = `Группа · ${conv.member_count || "?"} участников`;
    }
    document.getElementById("chat-status").textContent = statusText;

    // Update active in list
    document.querySelectorAll(".chat-item").forEach((el) => el.classList.remove("active"));
    const activeEl = document.querySelector(`.chat-item[data-type="${conv.type}"][data-id="${conv.id}"]`);
    if (activeEl) activeEl.classList.add("active");

    // Mobile
    if (window.innerWidth <= 768) {
        document.getElementById("sidebar").classList.add("hidden");
        document.getElementById("chat-area").classList.add("active");
    }

    if (conv.type === "private") {
        loadPrivateHistory(conv.id);
    } else {
        socket.emit("join_room", { room_id: conv.id });
    }
}

function goBackToSidebar() {
    if (currentChat && currentChat.type !== "private") {
        socket.emit("leave_room", { room_id: currentChat.id });
    }
    currentChat = null;
    document.getElementById("sidebar").classList.remove("hidden");
    document.getElementById("chat-area").classList.remove("active");
    document.getElementById("chat-title").textContent = "Выберите чат";
    document.getElementById("chat-status").textContent = "";
    document.getElementById("messages-list").innerHTML = "";
    document.getElementById("chat-header-avatar").classList.add("hidden");
}

async function loadRoomHistory(roomId) {
    try {
        const resp = await apiFetch(`/api/rooms/${roomId}/messages`);
        const data = await resp.json();
        data.messages.forEach((m) => renderMessage(m));
        scrollToBottom();
    } catch (e) { console.error(e); }
}

async function loadPrivateHistory(userId) {
    try {
        const resp = await apiFetch(`/api/private-messages/${userId}`);
        const data = await resp.json();
        data.messages.forEach((m) => renderMessage(m));
        scrollToBottom();
    } catch (e) { console.error(e); }
}

// --- Render message ---
function renderMessage(msg) {
    if (!currentChat) return;
    const container = document.getElementById("messages-list");
    const isOutgoing = msg.sender_id === currentUser.id;
    const div = document.createElement("div");
    div.className = `message ${isOutgoing ? "outgoing" : "incoming"}`;
    div.dataset.msgId = msg.id;
    div.dataset.senderId = msg.sender_id;
    if (msg.recipient_id) div.classList.add("private");

    const time = new Date(msg.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

    let contentHtml = "";
    if (msg.message_type === "text") {
        contentHtml = `<div class="message-bubble">${escapeHtml(msg.content || "")}</div>`;
    } else if (msg.message_type === "voice") {
        contentHtml = `
            <div class="message-bubble">
                <div class="voice-message">
                    <button class="voice-play-btn" data-src="/${msg.file_path}" onclick="toggleVoicePlay(this)">▶</button>
                    <div class="voice-wave"><canvas width="100" height="24"></canvas></div>
                    <span class="voice-time">0:00</span>
                </div>
            </div>`;
    } else if (msg.message_type === "video") {
        contentHtml = `
            <div class="message-bubble" style="padding:3px;">
                <div class="video-message">
                    <video src="/${msg.file_path}" controls playsinline preload="metadata"></video>
                </div>
            </div>`;
    } else if (msg.message_type === "photo" || msg.message_type === "image") {
        contentHtml = `
            <div class="message-bubble" style="padding:3px;">
                <div class="photo-message">
                    <img src="/${msg.file_path}" alt="Фото" loading="lazy" onclick="openPhotoViewer(this)">
                </div>
            </div>`;
    } else if (msg.message_type === "file") {
        contentHtml = `
            <div class="message-bubble">
                <div class="file-message">
                    <span class="file-icon">📎</span>
                    <span class="file-name">${escapeHtml(msg.content || "Файл")}</span>
                </div>
            </div>`;
    }

    const actionsBtn = isOutgoing
        ? `<button class="message-actions-btn" onclick="showMessageActions(event,${msg.id},${msg.sender_id})">⋯</button>`
        : "";

    div.innerHTML = `
        <div class="message-header">
            <span class="message-username">${escapeHtml(msg.sender_username)}</span>
            <span class="message-time">${time}</span>
        </div>
        ${contentHtml}
        ${actionsBtn}
    `;

    if (!isOutgoing) {
        const nameEl = div.querySelector(".message-username");
        if (nameEl) {
            nameEl.style.cursor = "pointer";
            nameEl.addEventListener("click", () => viewUserProfile(msg.sender_id));
        }
        div.addEventListener("touchstart", (e) => {
            const t = setTimeout(() => showMessageActions(e, msg.id, msg.sender_id), 500);
            div._lp = t;
        });
        div.addEventListener("touchend", () => clearTimeout(div._lp));
        div.addEventListener("touchmove", () => clearTimeout(div._lp));
    }

    container.appendChild(div);
}

function escapeHtml(t) {
    const d = document.createElement("div");
    d.textContent = t;
    return d.innerHTML;
}

function scrollToBottom() {
    const c = document.getElementById("messages-container");
    requestAnimationFrame(() => {
        c.scrollTop = c.scrollHeight;
    });
}

function isNearBottom() {
    const c = document.getElementById("messages-container");
    return c.scrollHeight - c.scrollTop - c.clientHeight < 150;
}

function updateScrollBtn() {
    const btn = document.getElementById("scroll-bottom-btn");
    if (!btn) return;
    btn.classList.toggle("hidden", isNearBottom());
}

function setupScrollEvents() {
    const c = document.getElementById("messages-container");
    if (!c) return;
    c.addEventListener("scroll", updateScrollBtn);
    document.getElementById("scroll-bottom-btn").addEventListener("click", () => {
        scrollToBottom();
        document.getElementById("scroll-bottom-btn").classList.add("hidden");
    });
}

// --- Send ---
async function sendMessage() {
    const input = document.getElementById("message-input");
    const content = input.value.trim();
    if (!content || !currentChat) return;
    input.value = "";
    input.style.height = "auto";

    if (currentChat.type === "private") {
        socket.emit("send_private_message", { recipient_id: currentChat.id, content });
    } else {
        socket.emit("send_message", { room_id: currentChat.id, content });
    }
    // Refresh convos after short delay to get the new message
    setTimeout(refreshConversations, 500);
}

// --- Voice send ---
voiceRecorder.onComplete = async (blob) => {
    if (!currentChat) return;
    try {
        const fd = new FormData();
        fd.append("file", blob, `v_${Date.now()}.webm`);
        fd.append("type", "voice");
        const resp = await apiFetch("/api/upload", { method: "POST", headers: {}, body: fd });
        const d = await resp.json();
        if (!resp.ok) throw new Error(d.error);
        socket.emit("send_voice_message", {
            room_id: currentChat.type !== "private" ? currentChat.id : null,
            recipient_id: currentChat.type === "private" ? currentChat.id : null,
            file_path: d.file_path,
        });
        setTimeout(refreshConversations, 500);
    } catch (e) { alert("Ошибка отправки голосового сообщения"); }
};

// --- Video send ---
videoRecorder.onComplete = async (blob) => {
    if (!currentChat) return;
    try {
        const fd = new FormData();
        fd.append("file", blob, `v_${Date.now()}.webm`);
        fd.append("type", "video");
        const resp = await apiFetch("/api/upload", { method: "POST", headers: {}, body: fd });
        const d = await resp.json();
        if (!resp.ok) throw new Error(d.error);
        socket.emit("send_video_message", {
            room_id: currentChat.type !== "private" ? currentChat.id : null,
            recipient_id: currentChat.type === "private" ? currentChat.id : null,
            file_path: d.file_path,
        });
        setTimeout(refreshConversations, 500);
    } catch (e) { alert("Ошибка отправки видео"); }
};

// --- Voice playback ---
function toggleVoicePlay(btn) {
    const wave = btn.parentElement.querySelector(".voice-wave canvas");
    const timeEl = btn.parentElement.querySelector(".voice-time");
    const src = btn.dataset.src;
    if (btn.dataset.playing === "true") {
        if (window._v) { window._v.pause(); window._v = null; }
        btn.dataset.playing = "false"; btn.textContent = "▶"; return;
    }
    if (window._v) {
        window._v.pause();
        const p = document.querySelector(".voice-play-btn[data-playing='true']");
        if (p) { p.dataset.playing = "false"; p.textContent = "▶"; }
    }
    const a = new Audio(src);
    window._v = a;
    btn.dataset.playing = "true"; btn.textContent = "⏸";
    const ctx = wave.getContext("2d");
    a.onloadedmetadata = () => {
        const total = a.duration;
        const upd = () => {
            if (!a.paused) {
                const c = a.currentTime;
                timeEl.textContent = `${String(Math.floor(c/60)).padStart(2,"0")}:${String(Math.floor(c%60)).padStart(2,"0")}`;
                ctx.clearRect(0, 0, wave.width, wave.height);
                ctx.fillStyle = "#667eea";
                ctx.fillRect(0, 0, wave.width * (c / total), wave.height);
                ctx.fillStyle = "rgba(255,255,255,0.15)";
                ctx.fillRect(wave.width * (c / total), 0, wave.width * (1 - c / total), wave.height);
                requestAnimationFrame(upd);
            }
        };
        upd();
    };
    a.onended = () => {
        btn.dataset.playing = "false"; btn.textContent = "▶";
        window._v = null; timeEl.textContent = "0:00";
        ctx.clearRect(0, 0, wave.width, wave.height);
    };
    a.play().catch(() => {});
}



// --- Message actions ---
function showMessageActions(event, msgId, senderId) {
    event.preventDefault();
    event.stopPropagation();
    closeContextMenu();
    if (senderId !== currentUser.id) return;
    const menu = document.createElement("div");
    menu.className = "message-context-menu"; menu.id = "msg-ctx";
    const del = document.createElement("div");
    del.className = "message-context-menu-item danger";
    del.innerHTML = '<img src="/static/img/delete.png" alt="" class="btn-img" style="width:16px;height:16px;display:inline;vertical-align:middle;"> Удалить';
    del.addEventListener("click", () => { closeContextMenu(); pendingDeleteMsgId = msgId; document.getElementById("delete-msg-modal").classList.remove("hidden"); });
    menu.appendChild(del);
    const x = Math.min(event.clientX || event.touches?.[0]?.clientX || 0, window.innerWidth - 180);
    const y = Math.min(event.clientY || event.touches?.[0]?.clientY || 0, window.innerHeight - 80);
    menu.style.left = x + "px"; menu.style.top = y + "px";
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("click", closeContextMenu, { once: true }), 10);
}

function closeContextMenu() { const m = document.getElementById("msg-ctx"); if (m) m.remove(); }

async function deleteMessage(msgId) {
    try {
        const resp = await apiFetch(`/api/messages/${msgId}`, { method: "DELETE" });
        if (resp.ok) {
            const el = document.querySelector(`.message[data-msg-id="${msgId}"]`);
            if (el) el.remove();
            socket.emit("delete_message", { message_id: msgId, room_id: currentChat?.type !== "private" ? currentChat?.id : null });
            setTimeout(refreshConversations, 300);
        }
    } catch (e) { console.error(e); }
}

// --- Notifications ---
function showNotification(msg) {
    if (msg.sender_id === currentUser.id) return;
    const relevant = currentChat && currentChat.type !== "private" && currentChat.id === msg.room_id;
    if (relevant) return;
    const conv = conversations.find((c) => c.type !== "private" && c.id === msg.room_id);
    if (!conv) return;
    chatNotifications.notify(conv.name, `${msg.sender_username}: ${msg.content || "Медиа"}`);
    chatNotifications.playSound("message");
}

// --- Search ---
async function handleSearch(query) {
    const results = document.getElementById("search-results");
    const chatList = document.getElementById("chat-list");
    if (!query || query.length < 1) {
        results.classList.add("hidden");
        chatList.classList.remove("hidden");
        return;
    }
    results.classList.remove("hidden");
    chatList.classList.add("hidden");

    // Search users
    try {
        const userResp = await apiFetch(`/api/users/search?q=${encodeURIComponent(query)}`);
        const userData = await userResp.json();
        const roomResp = await apiFetch(`/api/rooms/search?q=${encodeURIComponent(query)}`);
        const roomData = await roomResp.json();

        const userResults = document.getElementById("user-results");
        const roomResults = document.getElementById("room-results");
        userResults.innerHTML = "";
        roomResults.innerHTML = "";

        if (userData.users.length === 0) {
            userResults.innerHTML = '<div class="search-item" style="color:var(--text-muted);font-size:13px;">Ничего не найдено</div>';
        }
        userData.users.forEach((u) => {
            if (u.id === currentUser.id) return;
            const div = document.createElement("div");
            div.className = "search-item";
            const display = u.display_name || u.username;
            let avatarHtml;
            if (u.avatar && u.avatar !== "default.png") {
                avatarHtml = `<div class="chat-avatar private" style="background-image:url('/${u.avatar}');background-size:cover;background-position:center;border:2px solid ${u.is_online ? 'var(--success)' : 'var(--text-muted)'};background-color:transparent;"></div>`;
            } else {
                const initial = (display || "?").charAt(0).toUpperCase();
                avatarHtml = `<div class="chat-avatar private" style="background:${u.is_online ? 'var(--success)' : 'var(--text-muted)'}">${initial}</div>`;
            }
            div.innerHTML = `${avatarHtml}<span class="item-name">${escapeHtml(display)}</span>`;
            div.addEventListener("click", () => startPrivateChat(u));
            div.addEventListener("contextmenu", (e) => { e.preventDefault(); viewUserProfile(u.id); });
            userResults.appendChild(div);
        });

        if (roomData.rooms.length === 0) {
            roomResults.innerHTML = '<div class="search-item" style="color:var(--text-muted);font-size:13px;">Ничего не найдено</div>';
        }
        roomData.rooms.forEach((r) => {
            const div = document.createElement("div");
            div.className = "search-item";
            const iconFile = r.type === "channel" ? "channel.png" : "group.png";
            div.innerHTML = `<div class="chat-avatar ${r.type}"><img src="/static/img/${iconFile}" alt="" class="btn-img"></div><span class="item-name">${escapeHtml(r.name)}</span><span class="item-type">${r.type === "channel" ? "Канал" : "Группа"}</span>`;
            div.addEventListener("click", () => joinAndOpen(r));
            roomResults.appendChild(div);
        });
    } catch (e) { console.error(e); }
}

function startPrivateChat(user) {
    document.getElementById("search-input").value = "";
    document.getElementById("search-results").classList.add("hidden");
    document.getElementById("chat-list").classList.remove("hidden");
    const label = contactLabels[user.id];
    const name = label || user.display_name || user.username;
    selectChat({ type: "private", id: user.id, name: name, is_online: user.is_online });
}

async function joinAndOpen(room) {
    try {
        await apiFetch(`/api/rooms/${room.id}/join`, { method: "POST" });
        document.getElementById("search-input").value = "";
        document.getElementById("search-results").classList.add("hidden");
        document.getElementById("chat-list").classList.remove("hidden");
        selectChat({ type: room.type, id: room.id, name: room.name });
        loadConversations();
    } catch (e) { console.error(e); }
}

// --- Room profile ---
function openRoomProfile() {
    if (!currentChat || currentChat.type === "private") return;
    const modal = document.getElementById("room-profile-modal");
    const isChannel = currentChat.type === "channel";
    document.getElementById("room-profile-title").textContent = isChannel ? "Информация канала" : "Информация группы";
    document.getElementById("room-profile-name").textContent = currentChat.name || "";
    document.getElementById("room-profile-type").textContent = isChannel ? "Канал" : "Группа";
    const avatarEl = document.getElementById("room-profile-avatar");
    avatarEl.textContent = isChannel ? "📢" : "👥";

    // Load full room info from API
    apiFetch(`/api/rooms/${currentChat.id}`).then(r => r.json()).then(data => {
        const room = data.room || data;
        document.getElementById("room-profile-desc").textContent = room.description || "Нет описания";
        apiFetch(`/api/users/${room.created_by}`).then(r => r.json()).then(d => {
            document.getElementById("room-profile-creator").textContent = "Создатель: " + (d.user?.display_name || "Неизвестно");
        }).catch(() => {});
        const canEdit = room.created_by === currentUser.id;
        document.getElementById("room-profile-edit-btn").style.display = canEdit ? "" : "none";
        if (canEdit) {
            document.getElementById("room-edit-name").value = room.name || "";
            document.getElementById("room-edit-desc").value = room.description || "";
        }
    }).catch(() => {});

    document.getElementById("room-profile-info").classList.remove("hidden");
    document.getElementById("room-edit-form").classList.add("hidden");
    document.getElementById("room-profile-edit-btn").style.display = "";
    document.getElementById("room-profile-save-btn").style.display = "none";
    modal.classList.remove("hidden");
}

function closeRoomProfile() {
    document.getElementById("room-profile-modal").classList.add("hidden");
}

async function saveRoomProfile() {
    if (!currentChat) return;
    const name = document.getElementById("room-edit-name").value.trim();
    const description = document.getElementById("room-edit-desc").value.trim();
    if (!name) { alert("Название не может быть пустым"); return; }
    try {
        const resp = await apiFetch(`/api/rooms/${currentChat.id}`, {
            method: "PUT",
            body: JSON.stringify({ name, description: description || null }),
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); return; }
        currentChat.name = data.room.name;
        document.getElementById("chat-title").textContent = escapeHtml(data.room.name);
        closeRoomProfile();
        refreshConversations();
    } catch (e) { console.error(e); }
}

// --- Create group ---
let selectedGroupMembers = [];

function openCreateGroup() {
    document.getElementById("create-group-modal").classList.remove("hidden");
    document.getElementById("group-name").value = "";
    document.getElementById("group-member-search").value = "";
    document.getElementById("group-member-results").innerHTML = "";
    document.getElementById("group-selected-members").innerHTML = "";
    selectedGroupMembers = [];
}

async function searchGroupMembers(query) {
    const results = document.getElementById("group-member-results");
    if (!query || query.length < 1) { results.innerHTML = ""; return; }
    try {
        const resp = await apiFetch(`/api/users/search?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        results.innerHTML = "";
        data.users.forEach((u) => {
            if (u.id === currentUser.id || selectedGroupMembers.find((m) => m.id === u.id)) return;
            const div = document.createElement("div");
            div.className = "search-item";
            const display = u.display_name || u.username;
            div.innerHTML = `<span class="item-name">${escapeHtml(display)}</span>`;
            div.addEventListener("click", () => addGroupMember(u));
            results.appendChild(div);
        });
    } catch (e) { console.error(e); }
}

function addGroupMember(user) {
    if (selectedGroupMembers.find((m) => m.id === user.id)) return;
    selectedGroupMembers.push(user);
    renderSelectedMembers();
    document.getElementById("group-member-search").value = "";
    document.getElementById("group-member-results").innerHTML = "";
}

function removeGroupMember(userId) {
    selectedGroupMembers = selectedGroupMembers.filter((m) => m.id !== userId);
    renderSelectedMembers();
}

function renderSelectedMembers() {
    const container = document.getElementById("group-selected-members");
    container.innerHTML = "";
    selectedGroupMembers.forEach((m) => {
        const tag = document.createElement("span");
        tag.className = "selected-tag";
        const display = m.display_name || m.username;
        tag.innerHTML = `${escapeHtml(display)} <button onclick="removeGroupMember(${m.id})">✕</button>`;
        container.appendChild(tag);
    });
}

async function createGroup() {
    const name = document.getElementById("group-name").value.trim();
    if (!name) return;
    const memberIds = selectedGroupMembers.map((m) => m.id);
    try {
        const resp = await apiFetch("/api/groups", {
            method: "POST",
            body: JSON.stringify({ name, member_ids: memberIds }),
        });
        if (resp.ok) {
            document.getElementById("create-group-modal").classList.add("hidden");
            await loadConversations();
        }
    } catch (e) { console.error(e); }
}

// --- Create channel ---
async function createChannel() {
    const name = document.getElementById("channel-name").value.trim();
    if (!name) return;
    try {
        const resp = await apiFetch("/api/channels", {
            method: "POST",
            body: JSON.stringify({ name }),
        });
        if (resp.ok) {
            document.getElementById("create-channel-modal").classList.add("hidden");
            await loadConversations();
        }
    } catch (e) { console.error(e); }
}

// --- Event listeners ---
function setupEventListeners() {
    // Send
    document.getElementById("send-btn").addEventListener("click", sendMessage);
    document.getElementById("message-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    document.getElementById("message-input").addEventListener("input", function () {
        this.style.height = "auto";
        this.style.height = Math.min(this.scrollHeight, 100) + "px";
        if (!currentChat) return;
        socket.emit("typing", {
            room_id: currentChat.type !== "private" ? currentChat.id : null,
            recipient_id: currentChat.type === "private" ? currentChat.id : null,
            is_typing: true,
        });
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit("typing", {
                room_id: currentChat.type !== "private" ? currentChat.id : null,
                recipient_id: currentChat.type === "private" ? currentChat.id : null,
                is_typing: false,
            });
        }, 2000);
    });

    // Search
    document.getElementById("search-input").addEventListener("input", function () {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => handleSearch(this.value.trim()), 300);
    });

    // New chat button
    document.getElementById("new-chat-btn").addEventListener("click", () => {
        const menu = document.getElementById("new-chat-menu");
        menu.classList.toggle("hidden");
    });

    document.querySelectorAll(".dropdown-item").forEach((item) => {
        item.addEventListener("click", () => {
            document.getElementById("new-chat-menu").classList.add("hidden");
            if (item.dataset.action === "group") openCreateGroup();
            else document.getElementById("create-channel-modal").classList.remove("hidden");
        });
    });

    document.getElementById("new-chat-menu").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) e.target.classList.add("hidden");
    });

    // Back button
    document.getElementById("back-btn").addEventListener("click", goBackToSidebar);

    // Swipe
    document.getElementById("chat-area").addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; });
    document.getElementById("chat-area").addEventListener("touchend", (e) => {
        if (e.changedTouches[0].clientX - touchStartX > 80 && window.innerWidth <= 768) goBackToSidebar();
    });

    // Group modal
    document.getElementById("group-modal-cancel").addEventListener("click", () => document.getElementById("create-group-modal").classList.add("hidden"));
    document.getElementById("group-modal-confirm").addEventListener("click", createGroup);
    document.getElementById("create-group-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.target.classList.add("hidden"); });
    document.getElementById("group-member-search").addEventListener("input", function () { searchGroupMembers(this.value.trim()); });

    // Channel modal
    document.getElementById("channel-modal-cancel").addEventListener("click", () => document.getElementById("create-channel-modal").classList.add("hidden"));
    document.getElementById("channel-modal-confirm").addEventListener("click", createChannel);
    document.getElementById("create-channel-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.target.classList.add("hidden"); });

    // Logout
    document.getElementById("logout-btn").addEventListener("click", () => document.getElementById("logout-modal").classList.remove("hidden"));
    document.getElementById("logout-modal-cancel").addEventListener("click", () => document.getElementById("logout-modal").classList.add("hidden"));
    document.getElementById("logout-modal-confirm").addEventListener("click", async () => {
        await apiFetch("/api/auth/logout", { method: "POST" });
        clearToken();
        window.location.href = "/";
    });
    document.getElementById("logout-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.target.classList.add("hidden"); });

    // Delete message
    document.getElementById("delete-msg-cancel").addEventListener("click", () => { document.getElementById("delete-msg-modal").classList.add("hidden"); pendingDeleteMsgId = null; });
    document.getElementById("delete-msg-confirm").addEventListener("click", async () => {
        if (pendingDeleteMsgId) await deleteMessage(pendingDeleteMsgId);
        document.getElementById("delete-msg-modal").classList.add("hidden");
        pendingDeleteMsgId = null;
    });
    document.getElementById("delete-msg-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) { e.target.classList.add("hidden"); pendingDeleteMsgId = null; } });

    // Theme
    document.getElementById("theme-toggle-btn").addEventListener("click", () => document.getElementById("theme-panel").classList.toggle("hidden"));
    document.querySelectorAll(".theme-option").forEach((opt) => opt.addEventListener("click", () => applyTheme(opt.dataset.theme)));
    document.getElementById("theme-panel").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.target.classList.add("hidden"); });

    // File upload button
    document.getElementById("file-btn").addEventListener("click", () => document.getElementById("file-input").click());
    document.getElementById("file-input").addEventListener("change", handleFileSelect);

    // Drag & drop
    setupDragDrop();

    // Scroll to bottom button
    setupScrollEvents();

    // Avatar upload
    document.getElementById("settings-avatar-btn").addEventListener("click", () => document.getElementById("settings-avatar-input").click());
    document.getElementById("settings-avatar-input").addEventListener("change", handleAvatarUpload);

    // Profile / Settings
    document.getElementById("profile-btn").addEventListener("click", openSettings);
    document.getElementById("my-username").addEventListener("click", openSettings);
    document.getElementById("settings-close-btn").addEventListener("click", closeSettings);
    document.getElementById("settings-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSettings(); });
    document.querySelectorAll(".settings-tab").forEach((tab) => {
        tab.addEventListener("click", () => switchSettingsTab(tab.dataset.tab));
    });
    document.getElementById("settings-save-profile").addEventListener("click", saveProfile);
    document.getElementById("2fa-setup-btn").addEventListener("click", setup2FA);
    document.getElementById("2fa-cancel-setup-btn").addEventListener("click", cancel2FASetup);
    document.getElementById("2fa-enable-btn").addEventListener("click", enable2FA);
    document.getElementById("2fa-disable-btn").addEventListener("click", disable2FA);
    document.getElementById("resend-verification-btn").addEventListener("click", resendVerification);

    // User profile modal
    document.getElementById("user-profile-close-btn").addEventListener("click", closeUserProfile);
    document.getElementById("user-profile-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeUserProfile(); });
    document.getElementById("user-profile-message-btn").addEventListener("click", startChatFromProfile);
    document.getElementById("user-profile-contact-btn").addEventListener("click", addContactFromProfile);
    document.getElementById("user-profile-subscribe-btn").addEventListener("click", toggleSubscribeFromProfile);

    // Room profile modal
    document.getElementById("room-profile-close-btn").addEventListener("click", closeRoomProfile);
    document.getElementById("room-profile-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeRoomProfile(); });
    document.getElementById("room-profile-edit-btn").addEventListener("click", () => {
        document.getElementById("room-profile-info").classList.add("hidden");
        document.getElementById("room-edit-form").classList.remove("hidden");
        document.getElementById("room-profile-edit-btn").style.display = "none";
        document.getElementById("room-profile-save-btn").style.display = "";
    });
    document.getElementById("room-profile-save-btn").addEventListener("click", saveRoomProfile);
    // Open room profile on title click
    document.getElementById("chat-title").addEventListener("click", () => {
        if (currentChat && currentChat.type !== "private") openRoomProfile();
    });

    // Phone verification
    document.getElementById("phone-send-code-btn").addEventListener("click", async () => {
        try {
            const resp = await apiFetch("/api/auth/phone/send-code", { method: "POST" });
            const data = await resp.json();
            if (!resp.ok) { alert(data.error); return; }
            alert("Код отправлен на ваш телефон");
        } catch (e) { alert("Ошибка отправки кода"); }
    });
    document.getElementById("phone-verify-btn").addEventListener("click", async () => {
        const code = document.getElementById("phone-verify-code").value.trim();
        if (!code) { alert("Введите код из SMS"); return; }
        try {
            const resp = await apiFetch("/api/auth/phone/verify", {
                method: "POST",
                body: JSON.stringify({ code }),
            });
            const data = await resp.json();
            if (!resp.ok) { alert(data.error); return; }
            alert("Телефон подтверждён");
            loadSettings();
        } catch (e) { alert("Ошибка подтверждения"); }
    });
}

// --- Photo viewer ---
function openPhotoViewer(img) {
    const existing = document.getElementById("photo-viewer");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "photo-viewer";
    div.innerHTML = `<img src="${img.src}" alt="Фото">`;
    div.addEventListener("click", () => div.remove());
    document.body.appendChild(div);
}

// --- File upload (photo/video) ---
async function handleFileSelect(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !currentChat) return;
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) { alert("Только фото и видео"); return; }
    await uploadMediaFile(file, isVideo ? "video" : "photo");
}

// --- Drag & drop ---
function setupDragDrop() {
    const container = document.getElementById("messages-container");
    if (!container) return;

    let dragCounter = 0;

    container.addEventListener("dragenter", (e) => {
        e.preventDefault();
        if (!currentChat) return;
        dragCounter++;
        container.classList.add("drag-over");
    });

    container.addEventListener("dragover", (e) => {
        if (!currentChat) return;
        e.preventDefault();
    });

    container.addEventListener("dragleave", (e) => {
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            container.classList.remove("drag-over");
        }
    });

    container.addEventListener("drop", (e) => {
        e.preventDefault();
        dragCounter = 0;
        container.classList.remove("drag-over");
        if (!currentChat) return;
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const isVideo = file.type.startsWith("video/");
        const isImage = file.type.startsWith("image/");
        if (!isVideo && !isImage) { alert("Только фото и видео"); return; }
        uploadMediaFile(file, isVideo ? "video" : "photo");
    });
}

async function uploadMediaFile(file, msgType) {
    const fileType = msgType === "video" ? "video" : "photo";
    try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("type", fileType);
        const resp = await apiFetch("/api/upload", { method: "POST", headers: {}, body: fd });
        const d = await resp.json();
        if (!resp.ok) { alert(d.error || "Ошибка загрузки файла"); return; }
        socket.emit("send_media_message", {
            room_id: currentChat.type !== "private" ? currentChat.id : null,
            recipient_id: currentChat.type === "private" ? currentChat.id : null,
            file_path: d.file_path,
            media_type: msgType,
        });
        setTimeout(refreshConversations, 500);
    } catch (err) { alert("Ошибка загрузки файла"); console.error(err); }
}

// --- Settings ---
function openSettings() {
    document.getElementById("settings-modal").classList.remove("hidden");
    loadSettings();
}

function closeSettings() {
    document.getElementById("settings-modal").classList.add("hidden");
}

function switchSettingsTab(tab) {
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    document.querySelectorAll(".settings-tab-content").forEach((c) => c.classList.toggle("active", c.id === `settings-${tab}`));
}

async function loadSettings() {
    try {
        const resp = await apiFetch("/api/auth/me");
        const data = await resp.json();
        if (!resp.ok) return;
        const user = data.user;
        document.getElementById("settings-username").value = user.username || "";
        document.getElementById("settings-nickname").value = user.nickname || "";
        document.getElementById("settings-bio").value = user.bio || "";
        document.getElementById("settings-email").value = user.email || "";

        // Avatar
        const avatarImg = document.getElementById("settings-avatar-img");
        const avatarInitial = document.getElementById("settings-avatar-initial");
        if (user.avatar && user.avatar !== "default.png") {
            avatarImg.src = `/${user.avatar}`;
            avatarImg.classList.remove("hidden");
            avatarInitial.classList.add("hidden");
        } else {
            avatarImg.classList.add("hidden");
            avatarInitial.classList.remove("hidden");
            avatarInitial.textContent = (user.display_name || "?").charAt(0).toUpperCase();
        }

        // Email verification status
        const statusEl = document.getElementById("email-status-text");
        const resendBtn = document.getElementById("resend-verification-btn");
        if (user.is_verified) {
            statusEl.textContent = "✓ Email подтверждён";
            statusEl.style.color = "var(--success)";
            resendBtn.classList.add("hidden");
        } else {
            statusEl.textContent = "✗ Email не подтверждён";
            statusEl.style.color = "var(--warning)";
            resendBtn.classList.remove("hidden");
        }

        // 2FA status
        const statusText = document.getElementById("2fa-status-text");
        const setupBtn = document.getElementById("2fa-setup-btn");
        const setupArea = document.getElementById("2fa-setup-area");
        const disableArea = document.getElementById("2fa-disable-area");
        const qrSection = document.getElementById("2fa-qr-section");

        if (user.totp_enabled) {
            statusText.textContent = "Статус: включена ✓";
            statusText.style.color = "var(--success)";
            setupArea.classList.add("hidden");
            disableArea.classList.remove("hidden");
            qrSection.classList.add("hidden");
        } else {
            statusText.textContent = "Статус: выключена";
            statusText.style.color = "var(--text-secondary)";
            setupArea.classList.remove("hidden");
            disableArea.classList.add("hidden");
            qrSection.classList.add("hidden");
            setupBtn.classList.remove("hidden");
        }

        // Phone
        document.getElementById("settings-phone").value = user.phone || "";
        const phoneStatusEl = document.getElementById("phone-status-text");
        const phoneSendArea = document.getElementById("phone-send-code-area");
        const phoneVerifyArea = document.getElementById("phone-verify-area");
        if (user.phone_verified) {
            phoneStatusEl.textContent = "✓ Телефон подтверждён";
            phoneStatusEl.style.color = "var(--success)";
            phoneSendArea.classList.add("hidden");
            phoneVerifyArea.classList.add("hidden");
        } else if (user.phone) {
            phoneStatusEl.textContent = "✗ Телефон не подтверждён";
            phoneStatusEl.style.color = "var(--warning)";
            phoneSendArea.classList.remove("hidden");
            phoneVerifyArea.classList.remove("hidden");
        } else {
            phoneStatusEl.textContent = "Телефон не указан";
            phoneStatusEl.style.color = "var(--text-muted)";
            phoneSendArea.classList.add("hidden");
            phoneVerifyArea.classList.add("hidden");
        }
    } catch (e) { console.error(e); }
}

async function saveProfile() {
    const nickname = document.getElementById("settings-nickname").value.trim();
    const bio = document.getElementById("settings-bio").value.trim();
    const phone = document.getElementById("settings-phone").value.trim();
    try {
        const resp = await apiFetch("/api/profile", {
            method: "PUT",
            body: JSON.stringify({ nickname: nickname || null, bio: bio || null }),
        });
        // Save phone separately if changed
        if (phone) {
            await apiFetch("/api/auth/phone/update", {
                method: "POST",
                body: JSON.stringify({ phone }),
            });
        }
        const data = await resp.json();
        if (!resp.ok) {
            alert(data.error);
            return;
        }
        currentUser = data.user;
        document.getElementById("my-username").textContent = data.user.display_name || data.user.username;
        closeSettings();
    } catch (e) { console.error(e); }
}

// --- Avatar upload ---
async function handleAvatarUpload(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("type", "avatar");
        const resp = await apiFetch("/api/upload", { method: "POST", headers: {}, body: fd });
        const d = await resp.json();
        if (!resp.ok) throw new Error(d.error);
        // Save avatar path to profile
        const resp2 = await apiFetch("/api/profile", {
            method: "PUT",
            body: JSON.stringify({ avatar: d.file_path }),
        });
        const data = await resp2.json();
        if (!resp2.ok) throw new Error(data.error);
        currentUser = data.user;
        // Update avatar preview
        const avatarImg = document.getElementById("settings-avatar-img");
        const avatarInitial = document.getElementById("settings-avatar-initial");
        avatarImg.src = `/${d.file_path}`;
        avatarImg.classList.remove("hidden");
        avatarInitial.classList.add("hidden");
    } catch (err) { console.error(err); alert("Ошибка загрузки аватарки"); }
}

// --- 2FA ---
let _2faSecret = null;

async function setup2FA() {
    try {
        const resp = await apiFetch("/api/auth/2fa/setup", { method: "POST" });
        const data = await resp.json();
        if (!resp.ok) {
            alert(data.error);
            return;
        }
        _2faSecret = data.secret;
        const qrSection = document.getElementById("2fa-qr-section");
        const qrContainer = document.getElementById("2fa-qr-container");
        qrContainer.innerHTML = `<img src="data:image/png;base64,${data.qr_base64}" alt="QR Code">`;
        qrSection.classList.remove("hidden");
        document.getElementById("2fa-setup-btn").classList.add("hidden");
        document.getElementById("2fa-enable-code").value = "";
        document.getElementById("2fa-enable-code").focus();
    } catch (e) { console.error(e); }
}

function cancel2FASetup() {
    document.getElementById("2fa-qr-section").classList.add("hidden");
    document.getElementById("2fa-setup-btn").classList.remove("hidden");
    _2faSecret = null;
}

async function enable2FA() {
    const code = document.getElementById("2fa-enable-code").value.trim();
    if (!code) {
        alert("Введите код из Google Authenticator");
        return;
    }
    try {
        const resp = await apiFetch("/api/auth/2fa/enable", {
            method: "POST",
            body: JSON.stringify({ code }),
        });
        const data = await resp.json();
        if (!resp.ok) {
            alert(data.error);
            return;
        }
        cancel2FASetup();
        loadSettings();
    } catch (e) { console.error(e); }
}

async function disable2FA() {
    const password = document.getElementById("2fa-disable-password").value;
    if (!password) {
        alert("Введите пароль");
        return;
    }
    try {
        const resp = await apiFetch("/api/auth/2fa/disable", {
            method: "POST",
            body: JSON.stringify({ password }),
        });
        const data = await resp.json();
        if (!resp.ok) {
            alert(data.error);
            return;
        }
        document.getElementById("2fa-disable-password").value = "";
        loadSettings();
    } catch (e) { console.error(e); }
}

async function resendVerification() {
    try {
        const resp = await apiFetch("/api/auth/resend-verification", { method: "POST" });
        const data = await resp.json();
        if (!resp.ok) {
            alert(data.error);
            return;
        }
        alert("Письмо отправлено на вашу почту");
    } catch (e) { console.error(e); }
}

// --- User profile (view other users) ---
let _profileUserId = null;

async function viewUserProfile(userId) {
    _profileUserId = userId;
    try {
        const resp = await apiFetch(`/api/users/${userId}/profile`);
        const data = await resp.json();
        if (!resp.ok) return;
        const user = data.user;
        document.getElementById("user-profile-name").textContent = user.display_name || user.username;
        document.getElementById("user-profile-username").textContent = "";
        document.getElementById("user-profile-status").textContent = user.is_online ? "в сети" : "был(а) недавно";
        document.getElementById("user-profile-bio").textContent = user.bio || "Нет описания";
        document.getElementById("user-profile-bio").style.display = user.bio ? "block" : "none";
        document.getElementById("user-profile-subscribers").textContent = `${data.subscriber_count} подписчиков`;
        document.getElementById("user-profile-subscriptions").textContent = `${data.subscription_count} подписок`;

        // Avatar
        const avatarContainer = document.getElementById("user-profile-avatar");
        if (user.avatar && user.avatar !== "default.png") {
            avatarContainer.innerHTML = `<img src="/${user.avatar}" alt="Avatar">`;
        } else {
            avatarContainer.innerHTML = (user.display_name || "?").charAt(0).toUpperCase();
        }

        // Contact/subscribe buttons
        const contactBtn = document.getElementById("user-profile-contact-btn");
        const subscribeBtn = document.getElementById("user-profile-subscribe-btn");
        if (data.is_contact) {
            contactBtn.textContent = "✓ В контактах";
            contactBtn.classList.remove("outline");
        } else {
            contactBtn.textContent = "➕ В контакты";
            contactBtn.classList.add("outline");
        }
        if (data.is_subscribed) {
            subscribeBtn.textContent = "🔔 Подписан";
            subscribeBtn.classList.remove("outline");
        } else {
            subscribeBtn.textContent = "🔔 Подписаться";
            subscribeBtn.classList.add("outline");
        }

        // Contact label
        const labelArea = document.getElementById("user-profile-label-area");
        const labelInput = document.getElementById("user-profile-label-input");
        if (data.is_contact) {
            labelArea.classList.remove("hidden");
            labelInput.value = data.contact_label || "";
            // Remove previous listener to avoid duplicates
            labelInput.onblur = null;
            labelInput.onkeydown = null;
            labelInput.onblur = () => saveContactLabelAuto(userId, labelInput.value.trim());
            labelInput.onkeydown = (e) => {
                if (e.key === "Enter") { labelInput.blur(); }
            };
        } else {
            labelArea.classList.add("hidden");
        }

        document.getElementById("user-profile-modal").classList.remove("hidden");
    } catch (e) { console.error(e); }
}

function closeUserProfile() {
    document.getElementById("user-profile-modal").classList.add("hidden");
    _profileUserId = null;
}

function startChatFromProfile() {
    if (!_profileUserId) return;
    closeUserProfile();
    // Fetch user info and start chat
    apiFetch(`/api/users/${_profileUserId}`).then(r => r.json()).then(data => {
        if (data.user) startPrivateChat(data.user);
    });
}

async function addContactFromProfile() {
    if (!_profileUserId) return;
    try {
        const resp = await apiFetch("/api/contacts/add", {
            method: "POST",
            body: JSON.stringify({ contact_id: _profileUserId }),
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); return; }
        // Refresh profile view
        viewUserProfile(_profileUserId);
    } catch (e) { console.error(e); }
}

async function toggleSubscribeFromProfile() {
    if (!_profileUserId) return;
    const btn = document.getElementById("user-profile-subscribe-btn");
    const currentlySubscribed = btn.textContent.includes("Подписан");
    try {
        const resp = await apiFetch("/api/contacts/subscribe", {
            method: "POST",
            body: JSON.stringify({ contact_id: _profileUserId, subscribe: !currentlySubscribed }),
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); return; }
        viewUserProfile(_profileUserId);
    } catch (e) { console.error(e); }
}

async function saveContactLabel(userId, label) {
    try {
        const resp = await apiFetch(`/api/contacts/${userId}/label`, {
            method: "PUT",
            body: JSON.stringify({ label: label || null }),
        });
        if (!resp.ok) return;
        // Update cache
        if (label) contactLabels[userId] = label;
        else delete contactLabels[userId];
        // Refresh conversations to get updated names
        await refreshConversations();
        // Update current chat header from refreshed data
        if (currentChat && currentChat.type === "private" && currentChat.id === userId) {
            const updated = conversations.find(c => c.type === "private" && c.id === userId);
            if (updated) {
                currentChat.name = updated.name;
                document.getElementById("chat-title").textContent = escapeHtml(updated.name);
            }
        }
    } catch (e) { console.error(e); }
}

function saveContactLabelAuto(userId, label) {
    saveContactLabel(userId, label);
}

const API_BASE = window.location.origin;

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(";").shift();
    return null;
}

function getToken() {
    return localStorage.getItem("access_token") || getCookie("access_token_cookie");
}

function setToken(token) {
    localStorage.setItem("access_token", token);
}

function clearToken() {
    localStorage.removeItem("access_token");
    document.cookie = "access_token_cookie=; Max-Age=0; path=/";
}

async function apiFetch(url, options = {}) {
    const token = getToken();
    const isFormData = options.body instanceof FormData;
    const headers = { ...options.headers };
    if (!isFormData) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch(`${API_BASE}${url}`, { ...options, headers, credentials: "include" });
    return resp;
}

// 2FA state
let _temp2faToken = null;

// Auto-redirect if already logged in
document.addEventListener("DOMContentLoaded", () => {
    const token = getToken();
    if (token && document.getElementById("login-form")) {
        window.location.href = "/chat";
        return;
    }

    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");

    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const username = document.getElementById("username").value.trim();
            const password = document.getElementById("password").value;
            const codeEl = document.getElementById("2fa-code");
            const errorEl = document.getElementById("error-message");
            errorEl.classList.add("hidden");

            // If we have a pending 2FA flow, verify the code
            if (_temp2faToken) {
                const code = codeEl.value.trim();
                if (!code) {
                    errorEl.textContent = "Введите код из Google Authenticator";
                    errorEl.classList.remove("hidden");
                    return;
                }
                try {
                    const resp = await apiFetch("/api/auth/2fa/verify", {
                        method: "POST",
                        body: JSON.stringify({ temp_token: _temp2faToken, code }),
                    });
                    const data = await resp.json();
                    if (!resp.ok) {
                        errorEl.textContent = data.error;
                        errorEl.classList.remove("hidden");
                        return;
                    }
                    if (data.token) setToken(data.token);
                    window.location.href = "/chat";
                } catch (err) {
                    errorEl.textContent = "Ошибка соединения";
                    errorEl.classList.remove("hidden");
                }
                return;
            }

            // Normal login
            try {
                const resp = await apiFetch("/api/auth/login", {
                    method: "POST",
                    body: JSON.stringify({ username, password }),
                });
                const data = await resp.json();
                if (!resp.ok) {
                    errorEl.textContent = data.error;
                    errorEl.classList.remove("hidden");
                    return;
                }
                if (data.requires_2fa) {
                    _temp2faToken = data.temp_token;
                    document.getElementById("2fa-group").classList.remove("hidden");
                    codeEl.focus();
                    document.getElementById("login-btn").textContent = "Подтвердить";
                    return;
                }
                if (data.token) setToken(data.token);
                window.location.href = "/chat";
            } catch (err) {
                errorEl.textContent = "Ошибка соединения";
                errorEl.classList.remove("hidden");
            }
        });
    }

    if (registerForm) {
        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const username = document.getElementById("username").value.trim();
            const nickname = document.getElementById("nickname")?.value.trim() || "";
            const email = document.getElementById("email").value.trim();
            const phone = document.getElementById("phone")?.value.trim() || "";
            const password = document.getElementById("password").value;
            const confirm = document.getElementById("password-confirm").value;
            const errorEl = document.getElementById("error-message");
            errorEl.classList.add("hidden");

            if (password !== confirm) {
                errorEl.textContent = "Пароли не совпадают";
                errorEl.classList.remove("hidden");
                return;
            }

            try {
                const resp = await apiFetch("/api/auth/register", {
                    method: "POST",
                    body: JSON.stringify({ username, nickname, email, phone, password }),
                });
                const data = await resp.json();
                if (!resp.ok) {
                    errorEl.textContent = data.error;
                    errorEl.classList.remove("hidden");
                    return;
                }
                if (data.token) setToken(data.token);
                window.location.href = "/chat";
            } catch (err) {
                errorEl.textContent = "Ошибка соединения";
                errorEl.classList.remove("hidden");
            }
        });
    }
});

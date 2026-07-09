const TOKEN_KEY = "basin_token";
const USER_KEY = "basin_user";

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; }
}
export function setSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function authedFetch(url, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    clearSession();
    const err = new Error("Unauthorized");
    err.code = 401;
    throw err;
  }
  return res;
}

export async function login(username, password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");
  setSession(data.token, { user: data.user, name: data.name, role: data.role });
  return data;
}

export async function fetchState() {
  const res = await authedFetch("/api/state");
  if (!res.ok) throw new Error("Could not load vault state");
  return res.json();
}

export async function saveState(state) {
  const res = await authedFetch("/api/state", { method: "PUT", body: JSON.stringify(state) });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || "Save failed");
  }
  return res.json();
}

export async function fetchHistory() {
  const res = await authedFetch("/api/history");
  if (!res.ok) throw new Error("Could not load history");
  return res.json();
}

export async function fetchSnapshot(key) {
  const res = await authedFetch(`/api/history?key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error("Could not load snapshot");
  return res.json();
}

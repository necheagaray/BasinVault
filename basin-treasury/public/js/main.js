import * as api from "./api.js";
import { defaultState, mergeStates } from "./state.js";
import { debounce, toast, contourSVG, masterPlanSVG } from "./util.js";
import { renderForecast, renderReceivables, renderUnbilled, renderPayables, renderFixed, renderSettings, wireImportInputs, syncStickyOffsets } from "./views.js";

document.getElementById("login-contours").innerHTML = contourSVG(3, { w: 900, h: 700 });
document.getElementById("topbar-contours").innerHTML = contourSVG(7, { w: 1600, h: 100 });
document.getElementById("settings-blueprint").innerHTML = masterPlanSVG();

const RENDERERS = {
  forecast: renderForecast,
  receivables: renderReceivables,
  unbilled: renderUnbilled,
  payables: renderPayables,
  fixed: renderFixed,
  settings: renderSettings,
};

const Store = {
  state: null,
  user: null,
  canEdit: false,
  activeView: "forecast",
  lastLocalEdit: 0,
  editSeq: 0,
  savedSeq: 0,
  isSaving: false,
  historyCache: null,

  initials() {
    if (!this.user) return "?";
    return this.user.name.slice(0, 1).toUpperCase();
  },

  mutate(fn) {
    if (!this.canEdit) {
      toast("You have view-only access — ask Nick or Joel to make this change.", "error");
      return;
    }
    fn(this.state);
    this.lastLocalEdit = Date.now();
    this.editSeq++;
    this.render();
    this.scheduleSave();
  },

  render() {
    document.querySelectorAll(".sticky-tooltip, .breakdown-tooltip").forEach((el) => el.remove());
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${this.activeView}`));
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === this.activeView));
    RENDERERS[this.activeView](this);
    requestAnimationFrame(syncStickyOffsets);
  },

  scheduleSave: debounce(function () { Store.pushNow(); }, 1400),

  hasUnsavedWork() {
    return this.isSaving || this.editSeq !== this.savedSeq || (Date.now() - this.lastLocalEdit < 2000);
  },

  async pushNow() {
    if (this.isSaving) { this.scheduleSave(); return; } // a save is already in flight — try again after it finishes
    const seqBeingSaved = this.editSeq;
    this.isSaving = true;
    setSyncPill("saving", "saving…");
    try {
      // reconcile with whatever's actually on the server right now — field-level
      // merge, not a blind overwrite, so a concurrent edit from the other person
      // doesn't get silently discarded (and vice versa).
      const serverNow = await api.fetchState().catch(() => null);
      if (serverNow && this.state && serverNow.version !== this.state.version) {
        this.state = mergeStates(this.state, serverNow);
        this.render();
      }
      const res = await api.saveState(this.state);
      this.state.version = res.version;
      this.state.updatedAt = res.updatedAt;
      this.state.updatedBy = res.updatedBy;
      this.savedSeq = seqBeingSaved;
      setSyncPill("ok", `synced ${shortTime(res.updatedAt)}`);
      if (this.editSeq !== seqBeingSaved) this.scheduleSave(); // more edits arrived mid-save — save those too
    } catch (err) {
      setSyncPill("err", "save failed — retrying");
      setTimeout(() => this.scheduleSave(), 4000);
    } finally {
      this.isSaving = false;
    }
  },

  async pullNow({ silent = false } = {}) {
    try {
      const remote = await api.fetchState();
      if (!remote) return;
      if (this.hasUnsavedWork()) { if (!silent) toast("You have unsaved edits — finish those before pulling.", "info"); return; }
      if (this.state && remote.version === this.state.version) { if (!silent) toast("Already up to date", "info"); return; }
      this.state = remote;
      this.editSeq = 0;
      this.savedSeq = 0;
      this.render();
      if (!silent) toast(`Loaded latest version (v${remote.version}) from ${remote.updatedBy}`, "success");
      setSyncPill("ok", `synced ${shortTime(remote.updatedAt)}`);
    } catch (err) {
      if (!silent) toast("Could not reach the vault", "error");
    }
  },

  async loadHistory() {
    try {
      this.historyCache = await api.fetchHistory();
      if (this.activeView === "settings") this.render();
    } catch { this.historyCache = []; }
  },

  async restoreSnapshot(key) {
    try {
      const snap = await api.fetchSnapshot(key);
      this.state = snap.state;
      if (!this.state.unbilledReceivables) this.state.unbilledReceivables = [];
      if (!this.state.projectAutoSchedule) this.state.projectAutoSchedule = {};
      await this.pushNow();
      this.render();
      toast(`Restored version ${snap.version}`, "success");
    } catch { toast("Restore failed", "error"); }
  },
};
window.Store = Store; // handy for debugging in the console

function setSyncPill(cls, label) {
  const pill = document.getElementById("sync-pill");
  pill.className = `sync-pill ${cls}`;
  document.getElementById("sync-label").textContent = label;
}
function shortTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  const user = api.getUser();
  if (!api.getToken() || !user) return showLogin();

  Store.user = user;
  Store.canEdit = user.role === "editor";
  document.body.classList.toggle("viewer-mode", !Store.canEdit);
  document.getElementById("user-name").textContent = user.name;
  document.getElementById("user-initial").textContent = user.name[0];
  const roleTag = document.getElementById("role-tag");
  roleTag.style.display = Store.canEdit ? "none" : "";

  try {
    setSyncPill("saving", "loading…");
    let remote = await api.fetchState();
    if (!remote) {
      remote = defaultState();
      remote.updatedBy = user.user;
    }
    if (!remote.manualOutflowCategories.includes("Other")) remote.manualOutflowCategories.push("Other");
    if (!remote.unbilledReceivables) remote.unbilledReceivables = [];
    if (!remote.projectAutoSchedule) remote.projectAutoSchedule = {};
    Store.state = remote;
    showApp();
    Store.render();
    setSyncPill("ok", `synced ${shortTime(remote.updatedAt) || "now"}`);
    startPolling();
  } catch (err) {
    if (err.code === 401) return showLogin();
    toast("Could not load the vault. Check your connection and refresh.", "error", 8000);
  }
}

function startPolling() {
  setInterval(() => Store.pullNow({ silent: true }), 20000);
  window.addEventListener("focus", () => Store.pullNow({ silent: true }));
  window.addEventListener("resize", debounce(() => syncStickyOffsets(), 150));
}

function showLogin() {
  document.getElementById("login-screen").style.display = "flex";
  document.getElementById("app").classList.remove("visible");
}
function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").classList.add("visible");
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("login-user").value;
  const password = document.getElementById("login-pass").value;
  const btn = document.getElementById("login-submit");
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  btn.disabled = true; btn.textContent = "Unlocking…";
  try {
    await api.login(username, password);
    await boot();
  } catch (err) {
    errEl.textContent = err.message || "Login failed";
  } finally {
    btn.disabled = false; btn.textContent = "Unlock Vault";
  }
});

document.getElementById("btn-logout").addEventListener("click", () => {
  api.clearSession();
  location.reload();
});

document.getElementById("btn-save-version").addEventListener("click", () => Store.pushNow().then(() => toast("Version saved", "success")));

document.getElementById("sync-pill").addEventListener("click", () => Store.pullNow());

document.querySelector(".brand").addEventListener("click", () => {
  api.clearSession();
  location.reload();
});
document.querySelector(".brand").title = "Back to login";

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (!btn) return;
  Store.activeView = btn.dataset.view;
  Store.render();
  if (btn.dataset.view === "settings") Store.loadHistory();
});

wireImportInputs(Store);

boot();

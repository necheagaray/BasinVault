import * as api from "./api.js";
import { defaultState, mergeStates, migratePeriod, migrateTransfersToStateLevel, seedUnbilledRevenue } from "./state.js";
import { debounce, toast, contourSVG, masterPlanSVG, vaultDoorSVG } from "./util.js";
import { renderHome, renderForecast, renderReceivables, renderUnbilled, renderPayables, renderFixed, renderSettings, wireImportInputs, syncStickyOffsets, setGlobalViewWeeks, cfViewWeeks } from "./views.js";

document.getElementById("login-contours").innerHTML = contourSVG(3, { w: 900, h: 700 });
document.getElementById("topbar-contours").innerHTML = contourSVG(7, { w: 1600, h: 100 });
document.getElementById("settings-blueprint").innerHTML = masterPlanSVG();
document.getElementById("vault-door-decor").innerHTML = vaultDoorSVG(1100);
document.getElementById("vault-door-decor-forecast").innerHTML = vaultDoorSVG(1100);
document.getElementById("vault-door-decor-ar").innerHTML = vaultDoorSVG(1100);
document.getElementById("vault-door-decor-ub").innerHTML = vaultDoorSVG(1100);
document.getElementById("vault-door-decor-ap").innerHTML = vaultDoorSVG(1100);
document.getElementById("vault-door-decor-fixed").innerHTML = vaultDoorSVG(1100);

const RENDERERS = {
  home: renderHome,
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
  activeView: "home",
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
    if (!PREVIEW_MODE) this.scheduleSave(); // preview mode: edits work locally, nothing is ever saved
  },

  render() {
    // If the user currently has a text field focused inside the active view
    // (mid-edit — e.g. typing into a balance cell), rebuilding the DOM right
    // now would destroy that element and silently drop whatever they were
    // typing. Defer the render until they finish (blur) instead of pulling
    // the rug out from under them.
    const active = document.activeElement;
    const activeView = document.getElementById(`view-${this.activeView}`);
    const textLikeTypes = ["text", "number", "date", "search", "email", "tel", "url"];
    const isEditingField = active && activeView && activeView.contains(active) &&
      (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && textLikeTypes.includes(active.type)));
    if (isEditingField) {
      this.renderPending = true;
      if (!this._deferredRenderBound) {
        this._deferredRenderBound = true;
        active.addEventListener("blur", () => {
          this._deferredRenderBound = false;
          if (this.renderPending) { this.renderPending = false; this.render(); }
        }, { once: true });
      }
      return;
    }

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
      if (!this.state.transfers) this.state.transfers = [];
      if (!this.state.unbilledRevenue) this.state.unbilledRevenue = [];
      if (!this.state.tombstones) this.state.tombstones = { receivables: {}, payables: {}, fixedPayments: {}, unbilledReceivables: {}, transfers: {}, unbilledRevenue: {} };
      if (!this.state.tombstones.transfers) this.state.tombstones.transfers = {};
      if (!this.state.tombstones.unbilledRevenue) this.state.tombstones.unbilledRevenue = {};
      this.state.periods.forEach((p) => migratePeriod(p));
      migrateTransfersToStateLevel(this.state);
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

// Preview mode: ONLY activates when this file is opened directly (file://),
// which can never happen on the real deployed site (always served over
// http/https there) — so this has zero effect on the actual login flow.
// It exists purely so this single HTML file can be double-clicked and looked
// at immediately, with sample data, no login and nothing ever saved anywhere.
let PREVIEW_MODE = false;

function buildPreviewState() {
  const state = defaultState();
  state.unbilledRevenue = seedUnbilledRevenue();
  state.updatedBy = "preview";
  return state;
}

function bootPreview() {
  PREVIEW_MODE = true;
  Store.user = { user: "preview", name: "Preview", role: "editor" };
  Store.canEdit = true;
  document.body.classList.remove("viewer-mode");
  document.getElementById("user-name").textContent = "Preview";
  document.getElementById("user-initial").textContent = "P";
  document.getElementById("role-tag").style.display = "none";
  Store.state = buildPreviewState();
  showApp();
  Store.render();
  const pill = document.getElementById("sync-pill");
  pill.classList.add("preview-mode");
  pill.title = "Preview mode — opened as a local file, not the real site. Nothing here is saved.";
  document.getElementById("sync-label").textContent = "⚠ Preview — not saved";
}

async function boot() {
  if (location.protocol === "file:") return bootPreview();
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
    if (!remote.transfers) remote.transfers = [];
    if (!remote.tombstones) remote.tombstones = { receivables: {}, payables: {}, fixedPayments: {}, unbilledReceivables: {}, transfers: {}, unbilledRevenue: {} };
    if (!remote.tombstones.transfers) remote.tombstones.transfers = {};
    if (!remote.tombstones.unbilledRevenue) remote.tombstones.unbilledRevenue = {};
    if (!remote.unbilledRevenue) { remote.unbilledRevenue = seedUnbilledRevenue(); }
    remote.periods.forEach((p) => migratePeriod(p));
    migrateTransfersToStateLevel(remote);
    Store.state = remote;
    showApp();
    Store.render();
    setSyncPill("ok", `synced ${shortTime(remote.updatedAt) || "now"}`);
    startPolling();
  } catch (err) {
    console.error("Boot failed:", err);
    if (err.code === 401) {
      toast("Your session expired — please log in again.", "error", 6000);
      return showLogin();
    }
    toast(`Could not load the vault: ${err.message || "unknown error"}`, "error", 15000);
  }
}

function startPolling() {
  setInterval(() => Store.pullNow({ silent: true }), 60000);
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
    console.error("Login failed:", err);
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

document.getElementById("sync-pill").addEventListener("click", () => {
  if (PREVIEW_MODE) { toast("Preview mode — this file isn't connected to the real vault.", "info"); return; }
  Store.pullNow();
});

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

function syncWeeksToggleButtons() {
  document.querySelectorAll(".weeks-toggle-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.weeks) === cfViewWeeks));
}
document.getElementById("weeks-toggle-group").addEventListener("click", (e) => {
  const btn = e.target.closest(".weeks-toggle-btn");
  if (!btn) return;
  setGlobalViewWeeks(Number(btn.dataset.weeks));
  syncWeeksToggleButtons();
  Store.render();
});
syncWeeksToggleButtons();

wireImportInputs(Store);

boot();

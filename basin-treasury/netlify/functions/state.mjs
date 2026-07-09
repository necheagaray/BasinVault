import { getStore } from "@netlify/blobs";
import { requireAuth, json } from "./_auth.mjs";

const HISTORY_CAP = 30;

export default async (req) => {
  const payload = requireAuth(req);
  if (!payload) return json({ error: "Unauthorized" }, 401);

  const store = getStore("basin-treasury");

  if (req.method === "GET") {
    const data = await store.get("state", { type: "json" });
    return json(data || null);
  }

  if (req.method === "PUT") {
    if (payload.role !== "editor") return json({ error: "Your account is view-only" }, 403);

    let incoming;
    try {
      incoming = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const current = await store.get("state", { type: "json" });
    const nextVersion = (current?.version || 0) + 1;
    const toSave = {
      ...incoming,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
      updatedBy: payload.u,
    };

    await store.setJSON("state", toSave);

    // Best-effort version history so a bad save can be rolled back.
    try {
      const hist = getStore("basin-treasury-history");
      const histKey = `snap-${String(nextVersion).padStart(8, "0")}`;
      await hist.setJSON(histKey, {
        version: nextVersion,
        savedAt: toSave.updatedAt,
        savedBy: payload.u,
        state: toSave,
      });
      const idxRaw = await hist.get("index", { type: "json" });
      const idx = Array.isArray(idxRaw) ? idxRaw : [];
      idx.push({ key: histKey, version: nextVersion, savedAt: toSave.updatedAt, savedBy: payload.u });
      while (idx.length > HISTORY_CAP) {
        const old = idx.shift();
        await hist.delete(old.key).catch(() => {});
      }
      await hist.setJSON("index", idx);
    } catch {
      // history is a convenience feature only; never block a save on it
    }

    return json({ ok: true, version: nextVersion, updatedAt: toSave.updatedAt, updatedBy: toSave.updatedBy });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/state" };

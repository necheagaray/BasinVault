import { getStore } from "@netlify/blobs";
import { requireAuth, json } from "./_auth.mjs";

export default async (req) => {
  const payload = requireAuth(req);
  if (!payload) return json({ error: "Unauthorized" }, 401);
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const hist = getStore("basin-treasury-history");
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  if (!key) {
    const idx = (await hist.get("index", { type: "json" })) || [];
    return json(idx.slice().reverse());
  }

  const snap = await hist.get(key, { type: "json" });
  if (!snap) return json({ error: "Snapshot not found" }, 404);
  return json(snap);
};

export const config = { path: "/api/history" };

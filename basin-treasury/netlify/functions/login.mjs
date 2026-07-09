import { sign, json } from "./_auth.mjs";

const SESSION_DAYS = 21;

const USERS = {
  nick: { password: process.env.NICK_PASSWORD, name: "Nick", role: "editor" },
  joel: { password: process.env.JOEL_PASSWORD, name: "Joel", role: "editor" },
  wes: { password: process.env.WES_PASSWORD, name: "Wes", role: "viewer" },
  daniel: { password: process.env.DANIEL_PASSWORD, name: "Daniel", role: "viewer" },
  eric: { password: process.env.ERIC_PASSWORD, name: "Eric", role: "viewer" },
};

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = process.env.SESSION_SECRET;
  if (!secret) return json({ error: "Server misconfigured: SESSION_SECRET is not set" }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const username = String(body.username || "").toLowerCase().trim();
  const password = String(body.password || "");

  const record = USERS[username];
  if (!record || !record.password || !password || password !== record.password) {
    return json({ error: "Invalid username or password" }, 401);
  }

  const exp = Date.now() + 1000 * 60 * 60 * 24 * SESSION_DAYS;
  const token = sign({ u: username, role: record.role, exp }, secret);

  return json({ token, user: username, name: record.name, role: record.role, exp });
};

export const config = { path: "/api/login" };


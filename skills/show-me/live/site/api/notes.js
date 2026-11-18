import { put, list, get } from "@vercel/blob";

const ROOT = "notes";
const MAX_BODY = 64 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const SEP = "~";

const rid = () => Math.random().toString(36).slice(2, 10);
const stamp = () => String(Date.now()).padStart(15, "0");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
  }
  return data ? JSON.parse(data) : {};
}

async function append(sessionId, event) {
  const pathname = `${ROOT}/${sessionId}/${stamp()}-${rid()}.json`;
  await put(pathname, JSON.stringify({ ...event, at: new Date().toISOString() }), {
    access: "private", addRandomSuffix: false, contentType: "application/json",
  });
}

async function events(sessionId) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix: `${ROOT}/${sessionId}/`, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));
  return Promise.all(blobs.map(async (b) => {
    const r = await get(b.pathname, { access: "private" });
    return JSON.parse(await new Response(r.stream).text());
  }));
}

async function sessionIds() {
  const ids = new Set();
  let cursor;
  do {
    const page = await list({ prefix: `${ROOT}/`, mode: "folded", cursor, limit: 1000 });
    for (const f of page.folders || []) ids.add(f.slice(ROOT.length + 1).replace(/\/$/, ""));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return [...ids];
}

async function state(sessionId) {
  const anns = new Map();
  let created;
  for (const e of await events(sessionId)) {
    created ??= e.at;
    if (e.type === "create") anns.set(e.annotation.id, e.annotation);
    else if (e.type === "patch" && anns.has(e.id)) anns.set(e.id, { ...anns.get(e.id), ...e.data, updatedAt: e.at });
    else if (e.type === "delete") anns.delete(e.id);
    else if (e.type === "thread" && anns.has(e.id)) {
      const a = anns.get(e.id);
      anns.set(e.id, { ...a, thread: [...(a.thread || []), e.message] });
    }
  }
  return {
    id: sessionId, url: null, status: "active", createdAt: created || new Date().toISOString(),
    annotations: [...anns.values()],
  };
}

const sessionOf = (annotationId) => annotationId.split(SEP)[0];
const pendingOf = (s) => s.annotations.filter((a) => a.status === "pending" || !a.status);

const ALLOWED_PATCH = ["comment", "status", "resolvedBy", "intent", "severity"];

async function route(method, parts, req) {
  const [a, b, c] = parts;
  if (method === "GET" && a === "health") return [200, { status: "ok" }];

  if (a === "sessions" && !b) {
    if (method === "GET") return [200, await Promise.all((await sessionIds()).map(async (id) => {
      const s = await state(id);
      return { id, status: s.status, createdAt: s.createdAt, annotationCount: s.annotations.length };
    }))];
    if (method === "POST") {
      const id = `s-${rid()}`;
      const body = await readBody(req);
      return [201, { id, url: body.url || null, status: "active", createdAt: new Date().toISOString(), annotations: [] }];
    }
  }

  if (a === "sessions" && b) {
    if (!SLUG.test(b)) return [400, { error: "bad session id" }];
    if (method === "GET" && !c) return [200, await state(b)];
    if (method === "GET" && c === "pending") { const p = pendingOf(await state(b)); return [200, { count: p.length, annotations: p }]; }
    if (method === "GET" && c === "events") return ["sse"];
    if (method === "POST" && c === "annotations") {
      const body = await readBody(req);
      const annotation = {
        ...body, id: `${b}${SEP}${stamp()}${rid()}`, sessionId: b, status: "pending",
        createdAt: new Date().toISOString(), thread: [],
      };
      await append(b, { type: "create", annotation });
      return [201, annotation];
    }
  }

  if (method === "GET" && a === "pending") {
    const all = (await Promise.all((await sessionIds()).map(async (id) => pendingOf(await state(id))))).flat();
    return [200, { count: all.length, annotations: all }];
  }

  if (a === "annotations" && b) {
    const sid = sessionOf(b);
    if (!SLUG.test(sid)) return [404, { error: "not found" }];
    const find = async () => (await state(sid)).annotations.find((x) => x.id === b);
    const current = await find();
    if (!current) return [404, { error: "not found" }];
    if (method === "GET" && !c) return [200, current];
    if (method === "PATCH" && !c) {
      const body = await readBody(req);
      const data = Object.fromEntries(Object.entries(body).filter(([k]) => ALLOWED_PATCH.includes(k)));
      await append(sid, { type: "patch", id: b, data });
      return [200, { ...current, ...data }];
    }
    if (method === "DELETE" && !c) { await append(sid, { type: "delete", id: b }); return [204, null]; }
    if (method === "POST" && c === "thread") {
      const body = await readBody(req);
      const message = { id: rid(), role: body.role === "agent" ? "agent" : "human", content: String(body.content || "").slice(0, 4000), timestamp: Date.now() };
      await append(sid, { type: "thread", id: b, message });
      return [201, { ...current, thread: [...(current.thread || []), message] }];
    }
  }
  return [404, { error: "not found" }];
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = (url.searchParams.get("p") || "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    const [status, body] = await route(req.method, parts, req);
    if (status === "sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      return res.end("retry: 30000\n\n");
    }
    res.statusCode = status;
    if (body === null) return res.end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
}

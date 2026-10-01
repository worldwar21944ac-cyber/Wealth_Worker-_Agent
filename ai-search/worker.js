/**
 * AI Search Worker v3.0
 * =====================
 * Full-stack semantic search + RAG for wwwknockoutforever.com
 *
 * Bindings required:
 *   AI              — Workers AI (text embeddings + LLM)
 *   VECTORIZE       — Vectorize index (ai-search-index, 768-dim cosine)
 *   SEARCH_DB       — D1 database (bervashun-audit)
 *   SEARCH_ADMIN_KEY— Secret (plain text key for admin routes)
 *
 * Routes:
 *   GET  /health                  — liveness probe
 *   POST /index                   — ingest 1–50 documents
 *   DELETE /index/:id             — remove document by ID
 *   POST /search                  — semantic vector search
 *   GET  /search?q=               — browser-friendly search
 *   POST /ai/ask                  — RAG: retrieve + LLM answer
 *   GET  /documents               — list indexed docs (admin)
 *   DELETE /documents             — purge all docs (admin)
 *   GET  /api/search/status       — stats (admin)
 */

const ACCOUNT_ID = "fd6f05d3bbca4cc5f175ca4f7154552b";
const VECTOR_INDEX = "ai-search-index";
const EMBED_MODEL  = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL    = "@cf/meta/llama-3.1-8b-instruct";
const VERSION      = "3.0.0";

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
  "Access-Control-Expose-Headers":"X-Total-Count, X-Query-Time-Ms, X-Result-Count",
};

function corsHeaders(extra = {}) {
  return { ...CORS, "Content-Type": "application/json", ...extra };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(extra),
  });
}

function err(msg, status = 400) {
  return json({ error: msg, status }, status);
}

// ─── Auth helpers ──────────────────────────────────────────────────────────────
function isAdmin(req, env) {
  const key = req.headers.get("X-Search-Admin-Key")
    || (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return key && key === env.SEARCH_ADMIN_KEY;
}

function requireAdmin(req, env) {
  if (!isAdmin(req, env)) return err("Unauthorized — X-Search-Admin-Key required", 401);
  return null;
}

// ─── D1 helpers ───────────────────────────────────────────────────────────────
async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT    PRIMARY KEY,
      title       TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      category    TEXT    DEFAULT 'general',
      url         TEXT,
      metadata    TEXT    DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_docs_category ON search_documents(category);
    CREATE INDEX IF NOT EXISTS idx_search_docs_created  ON search_documents(created_at DESC);
  `);
}

// ─── Embedding helper ─────────────────────────────────────────────────────────
async function embed(text, env) {
  const r = await env.AI.run(EMBED_MODEL, { text: [text] });
  return r.data[0];
}

// ─── ID generator ─────────────────────────────────────────────────────────────
function genId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/** GET /health */
async function handleHealth(env) {
  return json({
    status:  "ok",
    version: VERSION,
    model:   { embed: EMBED_MODEL, llm: LLM_MODEL },
    index:   VECTOR_INDEX,
    ts:      Date.now(),
  });
}

/** POST /index  — body: { documents: [{id?, title, content, category?, url?, metadata?}] } */
async function handleIndex(req, env) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const docs = body.documents ?? (body.title ? [body] : null);
  if (!docs || !Array.isArray(docs) || docs.length === 0)
    return err("Provide { documents: [...] } (1–50 items)");
  if (docs.length > 50) return err("Max 50 documents per request");

  await ensureSchema(env.SEARCH_DB);
  const now = Date.now();
  const indexed = [];

  for (const doc of docs) {
    if (!doc.title || !doc.content) return err("Each document needs title + content");

    const id       = doc.id || genId();
    const category = doc.category || "general";
    const metadata = JSON.stringify(doc.metadata ?? {});
    const url      = doc.url || null;
    const text     = `${doc.title}\n\n${doc.content}`;

    // 1. Generate embedding
    const vector = await embed(text, env);

    // 2. Upsert into Vectorize
    await env.VECTORIZE.upsert([{
      id,
      values: vector,
      metadata: { title: doc.title, category, url: url || "" },
    }]);

    // 3. Upsert into D1
    await env.SEARCH_DB.prepare(`
      INSERT INTO search_documents (id, title, content, category, url, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title      = excluded.title,
        content    = excluded.content,
        category   = excluded.category,
        url        = excluded.url,
        metadata   = excluded.metadata,
        updated_at = excluded.updated_at
    `).bind(id, doc.title, doc.content, category, url, metadata, now, now).run();

    indexed.push({ id, title: doc.title, category });
  }

  return json({ indexed, count: indexed.length }, 201);
}

/** DELETE /index/:id */
async function handleDeleteDoc(id, req, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  await ensureSchema(env.SEARCH_DB);

  // Remove from Vectorize
  try { await env.VECTORIZE.deleteByIds([id]); } catch (_) {}

  // Remove from D1
  const r = await env.SEARCH_DB.prepare(
    "DELETE FROM search_documents WHERE id = ?"
  ).bind(id).run();

  if (r.meta?.changes === 0)
    return err(`Document '${id}' not found`, 404);

  return json({ deleted: id });
}

/** POST /search  — body: { query, top_k?, threshold?, category?, rerank? } */
async function handleSearch(req, env) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const query = (body.query || "").trim();
  if (!query) return err("query is required");

  const top_k     = Math.min(parseInt(body.top_k) || 5, 20);
  const threshold = parseFloat(body.threshold) || 0.5;
  const category  = body.category || null;

  const t0 = Date.now();

  // Embed query
  const vector = await embed(query, env);

  // Query Vectorize
  const filter = category ? { category: { $eq: category } } : undefined;
  const vRes = await env.VECTORIZE.query(vector, {
    topK:           top_k,
    returnMetadata: true,
    filter,
  });

  const matches = (vRes.matches || []).filter(m => m.score >= threshold);

  // Enrich from D1
  await ensureSchema(env.SEARCH_DB);
  const results = [];
  for (const m of matches) {
    const row = await env.SEARCH_DB.prepare(
      "SELECT id, title, content, category, url, metadata FROM search_documents WHERE id = ?"
    ).bind(m.id).first();

    results.push({
      id:       m.id,
      score:    Math.round(m.score * 1000) / 1000,
      title:    row?.title    ?? m.metadata?.title ?? "(unknown)",
      snippet:  row?.content  ? row.content.slice(0, 300) + (row.content.length > 300 ? "…" : "") : "",
      category: row?.category ?? m.metadata?.category ?? "general",
      url:      row?.url      ?? m.metadata?.url ?? null,
      metadata: row?.metadata ? JSON.parse(row.metadata) : {},
    });
  }

  const elapsed = Date.now() - t0;

  return json(
    { query, results, count: results.length, elapsed_ms: elapsed },
    200,
    { "X-Query-Time-Ms": String(elapsed), "X-Result-Count": String(results.length) }
  );
}

/** GET /search?q=  — browser-friendly */
async function handleSearchGet(url, env) {
  const q         = url.searchParams.get("q") || "";
  const top_k     = parseInt(url.searchParams.get("top_k")) || 5;
  const threshold = parseFloat(url.searchParams.get("threshold")) || 0.5;
  const category  = url.searchParams.get("category") || null;

  if (!q) return err("q parameter is required");

  // Reuse POST handler logic
  const fakeReq = new Request("https://x/search", {
    method: "POST",
    body:   JSON.stringify({ query: q, top_k, threshold, category }),
    headers: { "Content-Type": "application/json" },
  });
  return handleSearch(fakeReq, env);
}

/** POST /ai/ask  — RAG: embed → retrieve → prompt → LLM */
async function handleAsk(req, env) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const question = (body.question || "").trim();
  if (!question) return err("question is required");

  const top_k    = Math.min(parseInt(body.top_k) || 5, 10);
  const category = body.category || null;

  const t0 = Date.now();

  // 1. Retrieve relevant chunks
  const vector = await embed(question, env);
  const filter = category ? { category: { $eq: category } } : undefined;
  const vRes = await env.VECTORIZE.query(vector, {
    topK:           top_k,
    returnMetadata: true,
    filter,
  });

  await ensureSchema(env.SEARCH_DB);
  const contexts = [];
  for (const m of (vRes.matches || []).filter(m => m.score >= 0.45)) {
    const row = await env.SEARCH_DB.prepare(
      "SELECT title, content FROM search_documents WHERE id = ?"
    ).bind(m.id).first();
    if (row) contexts.push(`[${row.title}]\n${row.content}`);
  }

  // 2. Build RAG prompt
  const contextBlock = contexts.length
    ? contexts.join("\n\n---\n\n")
    : "No relevant documents were found in the knowledge base.";

  const systemPrompt = `You are a helpful AI assistant for Bervashun Trust Capital and the KnockoutForever platform.
Answer the user's question using ONLY the provided context below.
If the context does not contain enough information to answer, say so clearly.
Be concise, accurate, and professional.

CONTEXT:
${contextBlock}`;

  // 3. Call LLM
  const llmRes = await env.AI.run(LLM_MODEL, {
    messages: [
      { role: "system",    content: systemPrompt },
      { role: "user",      content: question },
    ],
    max_tokens: 512,
  });

  const answer = llmRes.response || "(No response generated)";
  const elapsed = Date.now() - t0;

  return json({
    question,
    answer,
    sources: contexts.length,
    elapsed_ms: elapsed,
    model: LLM_MODEL,
  });
}

/** GET /documents  — list with pagination */
async function handleListDocs(req, url, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  await ensureSchema(env.SEARCH_DB);

  const limit    = Math.min(parseInt(url.searchParams.get("limit")) || 20, 100);
  const offset   = parseInt(url.searchParams.get("offset")) || 0;
  const category = url.searchParams.get("category") || null;

  const where  = category ? "WHERE category = ?" : "";
  const params = category ? [category, limit, offset] : [limit, offset];

  const [rows, total] = await Promise.all([
    env.SEARCH_DB.prepare(
      `SELECT id, title, category, url, created_at, updated_at FROM search_documents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params).all(),
    env.SEARCH_DB.prepare(
      `SELECT COUNT(*) AS n FROM search_documents ${where}`
    ).bind(...(category ? [category] : [])).first(),
  ]);

  return json(
    { documents: rows.results || [], total: total?.n ?? 0, limit, offset },
    200,
    { "X-Total-Count": String(total?.n ?? 0) }
  );
}

/** DELETE /documents  — purge all */
async function handlePurge(req, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  await ensureSchema(env.SEARCH_DB);
  await env.SEARCH_DB.exec("DELETE FROM search_documents");

  return json({ purged: true, ts: Date.now() });
}

/** GET /api/search/status */
async function handleStatus(req, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  await ensureSchema(env.SEARCH_DB);

  const [total, cats] = await Promise.all([
    env.SEARCH_DB.prepare("SELECT COUNT(*) AS n FROM search_documents").first(),
    env.SEARCH_DB.prepare(
      "SELECT category, COUNT(*) AS n FROM search_documents GROUP BY category ORDER BY n DESC"
    ).all(),
  ]);

  return json({
    version,
    documents: total?.n ?? 0,
    categories: cats.results || [],
    models: { embed: EMBED_MODEL, llm: LLM_MODEL },
    index: VECTOR_INDEX,
    ts: Date.now(),
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url    = new URL(request.url);
    const path   = url.pathname.replace(/\/$/, "") || "/";
    const method = request.method.toUpperCase();

    try {
      // GET /health
      if (path === "/health" && method === "GET")
        return handleHealth(env);

      // POST /index
      if (path === "/index" && method === "POST")
        return handleIndex(request, env);

      // DELETE /index/:id
      if (path.startsWith("/index/") && method === "DELETE") {
        const id = path.slice(7);
        return handleDeleteDoc(id, request, env);
      }

      // POST /search
      if (path === "/search" && method === "POST")
        return handleSearch(request, env);

      // GET /search?q=
      if (path === "/search" && method === "GET")
        return handleSearchGet(url, env);

      // POST /ai/ask
      if (path === "/ai/ask" && method === "POST")
        return handleAsk(request, env);

      // GET /documents
      if (path === "/documents" && method === "GET")
        return handleListDocs(request, url, env);

      // DELETE /documents
      if (path === "/documents" && method === "DELETE")
        return handlePurge(request, env);

      // GET /api/search/status
      if (path === "/api/search/status" && method === "GET")
        return handleStatus(request, env);

      // 404
      return json({ error: "Not found", path, method }, 404);

    } catch (e) {
      console.error("AI Search error:", e);
      return json({ error: "Internal server error", detail: e.message }, 500);
    }
  },
};

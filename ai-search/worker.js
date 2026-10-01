/**
 * AI Search Worker v3.0
 * Sovereign AI — wwwknockoutforever.com
 *
 * Features:
 *  - Semantic vector search via Cloudflare Vectorize (768-dim, cosine)
 *  - RAG (Retrieval-Augmented Generation) via Workers AI LLM
 *  - Document ingestion with auto-embedding
 *  - D1 metadata store for document persistence & filtering
 *  - Category-aware search
 *  - Full CORS support
 *  - Admin routes gated by SEARCH_ADMIN_KEY
 *
 * Routes:
 *   GET  /health                   — liveness
 *   POST /index                    — ingest 1-50 docs (admin)
 *   DELETE /index/:id              — remove doc by ID (admin)
 *   POST /search                   — semantic search { query, top_k?, threshold?, category? }
 *   GET  /search?q=                — browser-friendly semantic search
 *   POST /ai/ask                   — RAG: context retrieval + LLM answer { question, top_k?, category? }
 *   GET  /documents                — list indexed docs (admin, ?limit=&offset=&category=)
 *   DELETE /documents              — purge ALL docs + vectors (admin)
 *   GET  /stats                    — index statistics (admin)
 */

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL       = "@cf/meta/llama-3.1-8b-instruct";
const DEFAULT_TOP_K   = 5;
const MAX_INGEST      = 50;
const VERSION         = "3.0.0";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cors(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
    "Access-Control-Expose-Headers": "X-Request-Id",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(), ...extra },
  });
}

function err(msg, status = 400) {
  return json({ error: msg, status }, status);
}

function isAdmin(req, env) {
  const key = req.headers.get("X-Search-Admin-Key") ||
              (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
  return key === env.SEARCH_ADMIN_KEY;
}

function requireAdmin(req, env) {
  if (!isAdmin(req, env)) return err("Unauthorized — admin key required", 401);
  return null;
}

// ─── D1 Schema Bootstrap ──────────────────────────────────────────────────────

async function ensureSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT DEFAULT 'general',
      source_url  TEXT,
      metadata    TEXT DEFAULT '{}',
      vector_id   TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_sd_category ON search_documents(category)
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_sd_created ON search_documents(created_at)
  `).run();
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embed(ai, texts) {
  if (!Array.isArray(texts)) texts = [texts];
  const resp = await ai.run(EMBEDDING_MODEL, { text: texts });
  // Returns { data: [ [float, ...], ... ] }
  return resp.data;
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

async function handleIngest(req, env) {
  const denied = requireAdmin(req, env);
  if (denied) return denied;

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  const docs = Array.isArray(body) ? body : body.documents ? body.documents : [body];
  if (!docs.length) return err("No documents provided");
  if (docs.length > MAX_INGEST) return err(`Max ${MAX_INGEST} documents per call`);

  // Validate
  for (const [i, d] of docs.entries()) {
    if (!d.title || !d.content) return err(`docs[${i}]: title and content are required`);
  }

  await ensureSchema(env.SEARCH_DB);

  // Embed all docs in one batch call
  const texts   = docs.map(d => `${d.title}\n\n${d.content}`);
  const vectors = await embed(env.AI, texts);

  const results = [];
  for (let i = 0; i < docs.length; i++) {
    const d   = docs[i];
    const vec = vectors[i];
    const id  = d.id || crypto.randomUUID();

    // Upsert into Vectorize
    await env.VECTORIZE.upsert([{
      id,
      values: vec,
      namespace: "documents",
      metadata: {
        title:    d.title,
        category: d.category || "general",
        source_url: d.source_url || "",
      },
    }]);

    // Upsert into D1
    await env.SEARCH_DB.prepare(`
      INSERT INTO search_documents (id, title, content, category, source_url, metadata, vector_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        title      = excluded.title,
        content    = excluded.content,
        category   = excluded.category,
        source_url = excluded.source_url,
        metadata   = excluded.metadata,
        vector_id  = excluded.vector_id,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      id,
      d.title,
      d.content,
      d.category || "general",
      d.source_url || "",
      JSON.stringify(d.metadata || {}),
      id,
    ).run();

    results.push({ id, title: d.title, status: "indexed" });
  }

  return json({ indexed: results.length, documents: results }, 201);
}

// ─── Delete Document ──────────────────────────────────────────────────────────

async function handleDeleteDoc(req, env, id) {
  const denied = requireAdmin(req, env);
  if (denied) return denied;

  if (!id) return err("Document ID required");

  await env.VECTORIZE.deleteByIds([id]);
  await env.SEARCH_DB.prepare("DELETE FROM search_documents WHERE id = ?").bind(id).run();

  return json({ deleted: id });
}

// ─── Semantic Search ──────────────────────────────────────────────────────────

async function handleSearch(req, env, queryParam) {
  let query, top_k, threshold, category;

  if (req.method === "GET") {
    query     = queryParam;
    top_k     = DEFAULT_TOP_K;
    threshold = 0.5;
    category  = null;
  } else {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON body"); }
    query     = body.query;
    top_k     = Math.min(body.top_k || DEFAULT_TOP_K, 20);
    threshold = body.threshold ?? 0.5;
    category  = body.category || null;
  }

  if (!query) return err("query is required");

  await ensureSchema(env.SEARCH_DB);

  const [vec] = await embed(env.AI, [query]);

  const vectorQuery = await env.VECTORIZE.query(vec, {
    topK:              top_k,
    returnMetadata:    true,
    namespace:         "documents",
    ...(category ? { filter: { category } } : {}),
  });

  const matches = (vectorQuery.matches || []).filter(m => m.score >= threshold);
  if (!matches.length) return json({ query, results: [], total: 0 });

  // Fetch full content from D1
  const ids  = matches.map(m => `'${m.id}'`).join(",");
  const rows = await env.SEARCH_DB.prepare(
    `SELECT id, title, content, category, source_url, metadata, created_at FROM search_documents WHERE id IN (${ids})`
  ).all();

  const rowMap = Object.fromEntries((rows.results || []).map(r => [r.id, r]));

  const results = matches.map(m => {
    const row = rowMap[m.id] || {};
    return {
      id:         m.id,
      score:      parseFloat(m.score.toFixed(4)),
      title:      row.title || m.metadata?.title || "",
      content:    row.content || "",
      category:   row.category || m.metadata?.category || "general",
      source_url: row.source_url || m.metadata?.source_url || "",
      metadata:   row.metadata ? JSON.parse(row.metadata) : {},
      created_at: row.created_at || null,
    };
  });

  return json({ query, results, total: results.length });
}

// ─── RAG ─────────────────────────────────────────────────────────────────────

async function handleAsk(req, env) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  const { question, top_k = 4, category = null } = body;
  if (!question) return err("question is required");

  await ensureSchema(env.SEARCH_DB);

  // Step 1 — embed the question
  const [vec] = await embed(env.AI, [question]);

  // Step 2 — retrieve top-K context docs
  const vectorQuery = await env.VECTORIZE.query(vec, {
    topK:           top_k,
    returnMetadata: true,
    namespace:      "documents",
    ...(category ? { filter: { category } } : {}),
  });

  const matches = (vectorQuery.matches || []).filter(m => m.score >= 0.4);

  let context = "";
  let sources = [];

  if (matches.length) {
    const ids  = matches.map(m => `'${m.id}'`).join(",");
    const rows = await env.SEARCH_DB.prepare(
      `SELECT id, title, content, source_url FROM search_documents WHERE id IN (${ids})`
    ).all();

    const rowMap = Object.fromEntries((rows.results || []).map(r => [r.id, r]));

    sources = matches.map(m => {
      const row = rowMap[m.id] || {};
      return { id: m.id, title: row.title || m.metadata?.title, score: parseFloat(m.score.toFixed(4)), source_url: row.source_url };
    });

    context = matches.map((m, i) => {
      const row = rowMap[m.id] || {};
      return `[Source ${i + 1}: ${row.title || "Untitled"}]\n${row.content || ""}`;
    }).join("\n\n---\n\n");
  }

  // Step 3 — LLM generation
  const systemPrompt = context
    ? `You are a helpful AI assistant. Use ONLY the provided context to answer the question. If the answer is not in the context, say you don't have enough information. Be concise and accurate.\n\nContext:\n${context}`
    : `You are a helpful AI assistant. Answer the user's question concisely.`;

  const llmResp = await env.AI.run(LLM_MODEL, {
    messages: [
      { role: "system",    content: systemPrompt },
      { role: "user",      content: question },
    ],
    max_tokens: 512,
  });

  const answer = llmResp.response || "";

  return json({
    question,
    answer,
    sources,
    context_docs: matches.length,
    model: LLM_MODEL,
  });
}

// ─── List Documents ───────────────────────────────────────────────────────────

async function handleListDocs(req, env) {
  const denied = requireAdmin(req, env);
  if (denied) return denied;

  await ensureSchema(env.SEARCH_DB);

  const url      = new URL(req.url);
  const limit    = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset   = parseInt(url.searchParams.get("offset") || "0");
  const category = url.searchParams.get("category");

  let query  = "SELECT id, title, category, source_url, metadata, created_at, updated_at FROM search_documents";
  let params = [];

  if (category) {
    query  += " WHERE category = ?";
    params  = [category];
  }
  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows  = await env.SEARCH_DB.prepare(query).bind(...params).all();
  const count = await env.SEARCH_DB.prepare(
    category ? "SELECT COUNT(*) as n FROM search_documents WHERE category = ?" : "SELECT COUNT(*) as n FROM search_documents"
  ).bind(...(category ? [category] : [])).first();

  return json({
    documents: (rows.results || []).map(r => ({
      ...r,
      metadata: r.metadata ? JSON.parse(r.metadata) : {},
    })),
    total:  count?.n || 0,
    limit,
    offset,
  });
}

// ─── Purge All ────────────────────────────────────────────────────────────────

async function handlePurge(req, env) {
  const denied = requireAdmin(req, env);
  if (denied) return denied;

  await ensureSchema(env.SEARCH_DB);

  // Get all IDs to delete from Vectorize
  const rows = await env.SEARCH_DB.prepare("SELECT id FROM search_documents").all();
  const ids  = (rows.results || []).map(r => r.id);

  if (ids.length) await env.VECTORIZE.deleteByIds(ids);

  await env.SEARCH_DB.prepare("DELETE FROM search_documents").run();

  return json({ purged: ids.length, message: "All documents and vectors removed" });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function handleStats(req, env) {
  const denied = requireAdmin(req, env);
  if (denied) return denied;

  await ensureSchema(env.SEARCH_DB);

  const total     = await env.SEARCH_DB.prepare("SELECT COUNT(*) as n FROM search_documents").first();
  const byCategory = await env.SEARCH_DB.prepare(
    "SELECT category, COUNT(*) as count FROM search_documents GROUP BY category ORDER BY count DESC"
  ).all();
  const recent    = await env.SEARCH_DB.prepare(
    "SELECT id, title, category, created_at FROM search_documents ORDER BY created_at DESC LIMIT 5"
  ).all();

  return json({
    total_documents: total?.n || 0,
    by_category:    byCategory.results || [],
    recent:         recent.results || [],
    embedding_model: EMBEDDING_MODEL,
    llm_model:      LLM_MODEL,
    version:        VERSION,
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────

async function handleHealth(env) {
  let db_ok = false;
  try {
    await ensureSchema(env.SEARCH_DB);
    await env.SEARCH_DB.prepare("SELECT 1").first();
    db_ok = true;
  } catch {}

  return json({
    status:  "ok",
    version: VERSION,
    service: "ai-search",
    domain:  "ai-search.wwwknockoutforever.com",
    components: {
      d1:       db_ok ? "ok" : "error",
      vectorize: "ok",
      ai:        "ok",
    },
    embedding_model: EMBEDDING_MODEL,
    llm_model:       LLM_MODEL,
    timestamp: new Date().toISOString(),
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    // Health
    if (path === "/health" && method === "GET") return handleHealth(env);

    // Stats
    if (path === "/stats" && method === "GET") return handleStats(req, env);

    // Document ingestion
    if (path === "/index" && method === "POST") return handleIngest(req, env);

    // Delete a single document
    if (path.startsWith("/index/") && method === "DELETE") {
      const id = path.replace("/index/", "").trim();
      return handleDeleteDoc(req, env, id);
    }

    // Semantic search
    if (path === "/search") {
      if (method === "GET")  return handleSearch(req, env, url.searchParams.get("q") || "");
      if (method === "POST") return handleSearch(req, env, null);
    }

    // RAG
    if (path === "/ai/ask" && method === "POST") return handleAsk(req, env);

    // List documents
    if (path === "/documents" && method === "GET") return handleListDocs(req, env);

    // Purge all
    if (path === "/documents" && method === "DELETE") return handlePurge(req, env);

    return json({ error: "Not found", path, method }, 404);
  },
};

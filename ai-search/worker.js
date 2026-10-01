/**
 * AI Search Worker v2.0
 * Sovereign Infrastructure — knockoutforever.com
 *
 * Endpoints:
 *   POST /index                  — ingest 1-50 documents (admin)
 *   DELETE /index/:id            — remove a document (admin)
 *   POST /search                 — semantic vector search
 *   GET  /search?q=              — browser-friendly semantic search
 *   POST /ai/ask                 — RAG answer (vector search + LLM)
 *   GET  /documents              — list indexed documents (admin)
 *   DELETE /documents            — purge all documents (admin)
 *   GET  /health                 — liveness
 *
 * Bindings (wrangler.toml):
 *   AI          — Workers AI
 *   VECTORIZE   — Vectorize index (ai-search-index, 768-dim cosine)
 *   SEARCH_DB   — D1 database (bervashun-audit / f2fe6105-...)
 *
 * Secrets:
 *   SEARCH_ADMIN_KEY  — arbitrary string; required for write + admin routes
 */

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL   = "@cf/meta/llama-3.1-8b-instruct";
const VERSION     = "2.0.0";

// ─── helpers ──────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Search-Admin-Key, Authorization",
    },
  });
}

function err(msg, status = 400) {
  return json({ error: msg, status }, status);
}

function isAdmin(req, env) {
  const key = req.headers.get("X-Search-Admin-Key") || req.headers.get("Authorization")?.replace("Bearer ", "");
  return key && key === env.SEARCH_ADMIN_KEY;
}

function requireAdmin(req, env) {
  if (!isAdmin(req, env)) return err("Unauthorized — X-Search-Admin-Key required", 401);
  return null;
}

function uid() {
  return crypto.randomUUID();
}

// ─── DB bootstrap ─────────────────────────────────────────────────────────────

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT DEFAULT 'general',
      source_url  TEXT,
      metadata    TEXT DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_docs_category ON search_documents(category);
    CREATE INDEX IF NOT EXISTS idx_search_docs_created  ON search_documents(created_at DESC);
  `);
}

// ─── embed ────────────────────────────────────────────────────────────────────

async function embed(env, texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const res = await env.AI.run(EMBED_MODEL, { text: input });
  return res.data; // float32[][]
}

// ─── routes ───────────────────────────────────────────────────────────────────

/** POST /index  — ingest documents */
async function handleIndex(req, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  const docs = Array.isArray(body) ? body : [body];
  if (docs.length === 0) return err("No documents provided");
  if (docs.length > 50) return err("Max 50 documents per request");

  const now = Date.now();
  const results = [];

  for (const doc of docs) {
    if (!doc.title || !doc.content) return err("Each document needs 'title' and 'content'");

    const id = doc.id || uid();
    const category = doc.category || "general";
    const metadata = doc.metadata || {};

    // Generate embedding from title + content
    const text = `${doc.title}\n\n${doc.content}`;
    const [vector] = await embed(env, [text]);

    // Upsert into Vectorize
    await env.VECTORIZE.upsert([{
      id,
      values: vector,
      metadata: { title: doc.title, category, source_url: doc.source_url || "" },
    }]);

    // Upsert into D1
    await env.SEARCH_DB.prepare(`
      INSERT INTO search_documents (id, title, content, category, source_url, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        category = excluded.category,
        source_url = excluded.source_url,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).bind(id, doc.title, doc.content, category, doc.source_url || null, JSON.stringify(metadata), now, now).run();

    results.push({ id, title: doc.title, status: "indexed" });
  }

  return json({ indexed: results.length, documents: results });
}

/** DELETE /index/:id  — remove a single document */
async function handleDeleteDoc(req, env, id) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  await env.VECTORIZE.deleteByIds([id]);
  await env.SEARCH_DB.prepare("DELETE FROM search_documents WHERE id = ?").bind(id).run();
  return json({ deleted: id });
}

/** POST /search or GET /search?q=  — semantic vector search */
async function handleSearch(req, env) {
  let query, top_k = 10, threshold = 0.5, category;

  if (req.method === "GET") {
    const url = new URL(req.url);
    query     = url.searchParams.get("q") || url.searchParams.get("query");
    top_k     = parseInt(url.searchParams.get("top_k") || "10");
    threshold = parseFloat(url.searchParams.get("threshold") || "0.5");
    category  = url.searchParams.get("category") || undefined;
  } else {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON body"); }
    ({ query, top_k = 10, threshold = 0.5, category } = body);
  }

  if (!query) return err("'query' is required");
  if (query.length > 2000) return err("Query too long (max 2000 chars)");

  const [vector] = await embed(env, [query]);

  const filter = category ? { category: { $eq: category } } : undefined;
  const matches = await env.VECTORIZE.query(vector, {
    topK: Math.min(top_k, 50),
    returnMetadata: "all",
    ...(filter ? { filter } : {}),
  });

  const hits = (matches.matches || []).filter(m => m.score >= threshold);

  // Hydrate from D1
  const ids = hits.map(h => h.id);
  const rows = ids.length
    ? (await env.SEARCH_DB.prepare(
        `SELECT id, title, content, category, source_url, metadata FROM search_documents WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids).all()).results
    : [];

  const rowMap = Object.fromEntries(rows.map(r => [r.id, r]));
  const results = hits.map(h => ({
    id: h.id,
    score: Math.round(h.score * 1000) / 1000,
    title: rowMap[h.id]?.title || h.metadata?.title || "—",
    content: (rowMap[h.id]?.content || "").substring(0, 500),
    category: rowMap[h.id]?.category || h.metadata?.category || "general",
    source_url: rowMap[h.id]?.source_url || h.metadata?.source_url || null,
    metadata: JSON.parse(rowMap[h.id]?.metadata || "{}"),
  }));

  return json({ query, count: results.length, threshold, results });
}

/** POST /ai/ask  — RAG: vector search → LLM answer */
async function handleAsk(req, env) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON body"); }

  const { question, top_k = 5, threshold = 0.45, category } = body;
  if (!question) return err("'question' is required");

  // Step 1: semantic search
  const [vector] = await embed(env, [question]);
  const filter = category ? { category: { $eq: category } } : undefined;
  const matches = await env.VECTORIZE.query(vector, {
    topK: Math.min(top_k, 20),
    returnMetadata: "all",
    ...(filter ? { filter } : {}),
  });

  const hits = (matches.matches || []).filter(m => m.score >= threshold);
  const ids = hits.map(h => h.id);
  const rows = ids.length
    ? (await env.SEARCH_DB.prepare(
        `SELECT id, title, content FROM search_documents WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids).all()).results
    : [];

  const rowMap = Object.fromEntries(rows.map(r => [r.id, r]));
  const context = hits.map(h => {
    const doc = rowMap[h.id];
    return doc ? `[${doc.title}]\n${doc.content}` : `[${h.metadata?.title || "doc"}]\n(content unavailable)`;
  }).join("\n\n---\n\n");

  // Step 2: LLM generation
  const systemPrompt = context.length
    ? `You are a precise, helpful AI assistant. Answer using ONLY the context below. If the answer is not in the context, say "I don't have that information."

Context:
${context}`
    : `You are a helpful AI assistant. The knowledge base contains no relevant documents for this query. Politely inform the user.`;

  const llmRes = await env.AI.run(LLM_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: question },
    ],
    max_tokens: 1024,
    temperature: 0.2,
  });

  const answer = llmRes.response || llmRes.result?.response || "";

  return json({
    question,
    answer,
    sources: hits.slice(0, top_k).map(h => ({
      id: h.id,
      score: Math.round(h.score * 1000) / 1000,
      title: rowMap[h.id]?.title || h.metadata?.title || "—",
    })),
    context_docs: hits.length,
  });
}

/** GET /documents  — list all indexed documents */
async function handleListDocs(req, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  const url = new URL(req.url);
  const limit  = Math.min(parseInt(url.searchParams.get("limit")  || "100"), 500);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const category = url.searchParams.get("category");

  const whereClause = category ? "WHERE category = ?" : "";
  const params = category ? [category, limit, offset] : [limit, offset];

  const { results } = await env.SEARCH_DB.prepare(
    `SELECT id, title, category, source_url, created_at, updated_at FROM search_documents ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params).all();

  return json({ count: results.length, limit, offset, documents: results });
}

/** DELETE /documents  — purge all documents */
async function handlePurgeDocs(req, env) {
  const guard = requireAdmin(req, env);
  if (guard) return guard;

  // D1 purge
  const { results: allDocs } = await env.SEARCH_DB.prepare("SELECT id FROM search_documents").all();
  const ids = allDocs.map(d => d.id);

  if (ids.length > 0) {
    // Delete from Vectorize in batches of 100
    for (let i = 0; i < ids.length; i += 100) {
      await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
    }
    await env.SEARCH_DB.prepare("DELETE FROM search_documents").run();
  }

  return json({ purged: ids.length });
}

/** GET /health  — liveness */
function handleHealth(env) {
  return json({
    status: "ok",
    service: "ai-search",
    version: VERSION,
    timestamp: new Date().toISOString(),
    models: { embed: EMBED_MODEL, llm: LLM_MODEL },
  });
}

// ─── main ─────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Search-Admin-Key, Authorization",
        },
      });
    }

    // Ensure schema on every cold start (idempotent)
    ctx.waitUntil(ensureSchema(env.SEARCH_DB));

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = req.method;

    try {
      // GET /health
      if (path === "/health" && method === "GET") return handleHealth(env);

      // POST /index
      if (path === "/index" && method === "POST") return await handleIndex(req, env);

      // DELETE /index/:id
      const deleteMatch = path.match(/^\/index\/(.+)$/);
      if (deleteMatch && method === "DELETE") return await handleDeleteDoc(req, env, deleteMatch[1]);

      // POST /search  |  GET /search?q=
      if (path === "/search" && (method === "POST" || method === "GET")) return await handleSearch(req, env);

      // POST /ai/ask
      if (path === "/ai/ask" && method === "POST") return await handleAsk(req, env);

      // GET /documents
      if (path === "/documents" && method === "GET") return await handleListDocs(req, env);

      // DELETE /documents
      if (path === "/documents" && method === "DELETE") return await handlePurgeDocs(req, env);

      return err("Not found", 404);
    } catch (e) {
      console.error("AI Search error:", e);
      return err(`Internal error: ${e.message}`, 500);
    }
  },
};

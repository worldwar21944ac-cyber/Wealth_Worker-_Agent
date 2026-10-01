/**
 * ai-search — Sovereign AI Search Worker v1.0
 * Cloudflare Workers AI (BGE embeddings + Llama-3.1-8B RAG) + Vectorize + D1
 *
 * Routes:
 *   GET  /health                   — liveness
 *   POST /index                    — ingest document(s) into Vectorize + D1
 *   DELETE /index/:id              — remove document by ID
 *   POST /search                   — semantic vector search
 *   GET  /search?q=...             — browser-friendly semantic search
 *   POST /ai/ask                   — RAG: search + LLM answer
 *   GET  /documents                — list indexed documents (admin)
 *   DELETE /documents              — purge all documents (admin)
 *
 * Bindings (wrangler.toml):
 *   AI         — Workers AI (embeddings + LLM)
 *   VECTORIZE  — Vectorize index "ai-search-index"
 *   SEARCH_DB  — D1 database "bervashun-audit" (search_documents table)
 *   SEARCH_ADMIN_KEY — secret for admin routes
 */

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768-dim, fast
const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const TOP_K = 8;
const SIMILARITY_THRESHOLD = 0.35;

// ─── CORS helpers ──────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ success: false, error: msg }, status);
}

// ─── Auth ───────────────────────────────────────────────────────────────────
function isAdmin(req, env) {
  const key =
    req.headers.get("X-Search-Admin-Key") ||
    req.headers.get("Authorization")?.replace("Bearer ", "");
  return key === env.SEARCH_ADMIN_KEY;
}

// ─── D1 schema init ─────────────────────────────────────────────────────────
async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT,
      category    TEXT,
      metadata    TEXT,
      indexed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ─── Embedding helper ────────────────────────────────────────────────────────
async function embed(ai, text) {
  const res = await ai.run(EMBEDDING_MODEL, { text: [text] });
  // Workers AI returns { data: [[...floats]] }
  return res.data[0];
}

// ─── Chunk text into ≤500-token windows ─────────────────────────────────────
function chunkText(text, maxWords = 400) {
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
  }
  return chunks.filter(Boolean);
}

// ─── Generate deterministic chunk ID ────────────────────────────────────────
function chunkId(docId, chunkIndex) {
  return `${docId}:chunk:${chunkIndex}`;
}

// ─── Route: POST /index ──────────────────────────────────────────────────────
async function handleIndex(req, env) {
  if (!isAdmin(req, env)) return err("Unauthorized", 401);

  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  // Accept single doc or array
  const docs = Array.isArray(body) ? body : [body];
  if (docs.length > 50) return err("Max 50 documents per request");

  await ensureSchema(env.SEARCH_DB);

  const results = [];

  for (const doc of docs) {
    const { id, title, content, source, category, metadata } = doc;

    if (!id || !title || !content)
      return err(`Document missing required fields: id, title, content`);

    // Store in D1
    await env.SEARCH_DB.prepare(
      `INSERT OR REPLACE INTO search_documents
         (id, title, content, source, category, metadata, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
      .bind(id, title, content, source || null, category || null,
            metadata ? JSON.stringify(metadata) : null)
      .run();

    // Chunk + embed + upsert into Vectorize
    const chunks = chunkText(content);
    const vectors = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText_ = chunks[i];
      const contextualText = `${title}\n\n${chunkText_}`;
      const vector = await embed(env.AI, contextualText);

      vectors.push({
        id: chunkId(id, i),
        values: vector,
        metadata: {
          doc_id: id,
          chunk_index: i,
          title,
          source: source || "",
          category: category || "",
          snippet: chunkText_.slice(0, 300),
        },
      });
    }

    // Upsert all chunks in one call
    await env.VECTORIZE.upsert(vectors);

    results.push({ id, title, chunks: chunks.length, status: "indexed" });
  }

  return json({ success: true, indexed: results.length, documents: results });
}

// ─── Route: DELETE /index/:id ────────────────────────────────────────────────
async function handleDeleteDoc(req, env, docId) {
  if (!isAdmin(req, env)) return err("Unauthorized", 401);

  // Remove from D1
  await env.SEARCH_DB.prepare(`DELETE FROM search_documents WHERE id = ?`)
    .bind(docId)
    .run();

  // Vectorize doesn't support prefix-delete — we delete known chunk IDs
  // Fetch the document to know how many chunks it had
  // (We try up to 200 chunks)
  const ids = Array.from({ length: 200 }, (_, i) => chunkId(docId, i));
  try { await env.VECTORIZE.deleteByIds(ids); } catch (_) { /* best effort */ }

  return json({ success: true, deleted: docId });
}

// ─── Route: POST /search or GET /search?q= ──────────────────────────────────
async function handleSearch(req, env, url) {
  let query, topK, threshold, category;

  if (req.method === "GET") {
    query      = url.searchParams.get("q") || url.searchParams.get("query");
    topK       = parseInt(url.searchParams.get("top_k") || TOP_K);
    threshold  = parseFloat(url.searchParams.get("threshold") || SIMILARITY_THRESHOLD);
    category   = url.searchParams.get("category");
  } else {
    let body;
    try { body = await req.json(); } catch { return err("Invalid JSON"); }
    query     = body.query || body.q;
    topK      = body.top_k || TOP_K;
    threshold = body.threshold ?? SIMILARITY_THRESHOLD;
    category  = body.category;
  }

  if (!query) return err("Missing required field: query");
  if (topK < 1 || topK > 50) topK = TOP_K;

  const t0 = Date.now();

  // Embed query
  const queryVector = await embed(env.AI, query);

  // Query Vectorize
  const vectorFilter = category ? { category: { $eq: category } } : {};
  const matches = await env.VECTORIZE.query(queryVector, {
    topK,
    returnMetadata: true,
    filter: Object.keys(vectorFilter).length ? vectorFilter : undefined,
  });

  // Deduplicate by doc_id, keeping highest-score chunk per document
  const dedupMap = new Map();
  for (const match of matches.matches || []) {
    if (match.score < threshold) continue;
    const { doc_id, title, source, category: cat, snippet } = match.metadata;
    if (!dedupMap.has(doc_id) || match.score > dedupMap.get(doc_id).score) {
      dedupMap.set(doc_id, {
        id: doc_id,
        title,
        source: source || null,
        category: cat || null,
        snippet,
        score: match.score,
        chunk_id: match.id,
      });
    }
  }

  const results = [...dedupMap.values()].sort((a, b) => b.score - a.score);
  const latency = Date.now() - t0;

  return json({
    success: true,
    query,
    results,
    total: results.length,
    latency_ms: latency,
  });
}

// ─── Route: POST /ai/ask (RAG) ───────────────────────────────────────────────
async function handleAsk(req, env) {
  let body;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const { question, top_k, category } = body;
  if (!question) return err("Missing required field: question");

  const t0 = Date.now();

  // 1. Embed + search
  const queryVector = await embed(env.AI, question);
  const vectorFilter = category ? { category: { $eq: category } } : {};
  const matches = await env.VECTORIZE.query(queryVector, {
    topK: top_k || 5,
    returnMetadata: true,
    filter: Object.keys(vectorFilter).length ? vectorFilter : undefined,
  });

  // 2. Build context from top chunks
  const relevantChunks = (matches.matches || [])
    .filter(m => m.score >= SIMILARITY_THRESHOLD)
    .slice(0, 5);

  if (relevantChunks.length === 0) {
    return json({
      success: true,
      question,
      answer: "I don't have enough information in the knowledge base to answer that question.",
      sources: [],
      latency_ms: Date.now() - t0,
    });
  }

  const contextBlock = relevantChunks
    .map((m, i) => `[${i + 1}] ${m.metadata.title}\n${m.metadata.snippet}`)
    .join("\n\n---\n\n");

  // 3. Call LLM
  const llmRes = await env.AI.run(LLM_MODEL, {
    messages: [
      {
        role: "system",
        content: `You are a precise AI assistant. Answer the user's question using ONLY the provided context.
If the answer isn't in the context, say so. Be concise and accurate. Cite source numbers [1], [2] etc.

CONTEXT:
${contextBlock}`,
      },
      { role: "user", content: question },
    ],
    max_tokens: 512,
    temperature: 0.2,
  });

  const sources = relevantChunks.map((m, i) => ({
    ref: i + 1,
    doc_id: m.metadata.doc_id,
    title: m.metadata.title,
    score: m.score,
    snippet: m.metadata.snippet?.slice(0, 200),
  }));

  return json({
    success: true,
    question,
    answer: llmRes.response,
    sources,
    latency_ms: Date.now() - t0,
  });
}

// ─── Route: GET /documents (admin) ───────────────────────────────────────────
async function handleListDocuments(req, env, url) {
  if (!isAdmin(req, env)) return err("Unauthorized", 401);
  await ensureSchema(env.SEARCH_DB);

  const limit = parseInt(url.searchParams.get("limit") || "100");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const category = url.searchParams.get("category");

  let query = `SELECT id, title, source, category, indexed_at FROM search_documents`;
  const params = [];
  if (category) { query += ` WHERE category = ?`; params.push(category); }
  query += ` ORDER BY indexed_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const { results } = await env.SEARCH_DB.prepare(query).bind(...params).all();
  return json({ success: true, total: results.length, documents: results });
}

// ─── Route: DELETE /documents (admin purge) ──────────────────────────────────
async function handlePurgeDocuments(req, env) {
  if (!isAdmin(req, env)) return err("Unauthorized", 401);
  await ensureSchema(env.SEARCH_DB);
  await env.SEARCH_DB.prepare(`DELETE FROM search_documents`).run();
  return json({ success: true, message: "All documents purged from D1. Vectorize vectors require manual deletion." });
}

// ─── Main fetch handler ──────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // Health
      if (path === "/health" && method === "GET") {
        return json({
          status: "ok",
          service: "ai-search",
          version: "1.0.0",
          models: { embedding: EMBEDDING_MODEL, llm: LLM_MODEL },
          timestamp: new Date().toISOString(),
        });
      }

      // Index: ingest documents
      if (path === "/index" && method === "POST") return handleIndex(request, env);

      // Delete single document
      const deleteMatch = path.match(/^\/index\/(.+)$/);
      if (deleteMatch && method === "DELETE")
        return handleDeleteDoc(request, env, deleteMatch[1]);

      // Search (GET + POST)
      if (path === "/search" && (method === "GET" || method === "POST"))
        return handleSearch(request, env, url);

      // RAG ask
      if (path === "/ai/ask" && method === "POST") return handleAsk(request, env);

      // List documents
      if (path === "/documents" && method === "GET")
        return handleListDocuments(request, env, url);

      // Purge documents
      if (path === "/documents" && method === "DELETE")
        return handlePurgeDocuments(request, env);

      // Root info page
      if (path === "/" && method === "GET") {
        return json({
          service: "Sovereign AI Search",
          version: "1.0.0",
          endpoints: {
            "GET  /health":        "liveness check",
            "POST /index":         "ingest document(s) — admin",
            "DELETE /index/:id":   "remove document by ID — admin",
            "GET  /search?q=":     "semantic search (browser friendly)",
            "POST /search":        "semantic search { query, top_k?, threshold?, category? }",
            "POST /ai/ask":        "RAG answer { question, top_k?, category? }",
            "GET  /documents":     "list indexed docs — admin",
            "DELETE /documents":   "purge all docs — admin",
          },
        });
      }

      return err("Not found", 404);
    } catch (e) {
      console.error("ai-search error:", e);
      return err(`Internal error: ${e.message}`, 500);
    }
  },
};

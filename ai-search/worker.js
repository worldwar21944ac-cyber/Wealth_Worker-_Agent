/**
 * ai-search Worker v1.1
 * Cloudflare Worker — semantic vector search + RAG powered by Workers AI + Vectorize + D1
 *
 * Bindings:
 *   AI            — Workers AI (embedding + LLM)
 *   VECTORIZE     — Vectorize index (ai-search-index, 768-dim cosine)
 *   SEARCH_DB     — D1 database (bervashun-audit)
 *   SEARCH_ADMIN_KEY — Worker secret
 *
 * Routes:
 *   POST /index                  — ingest 1-50 docs          [admin]
 *   DELETE /index/:id            — remove one document       [admin]
 *   POST /search                 — semantic search           [open]
 *   GET  /search?q=              — browser-friendly search   [open]
 *   POST /ai/ask                 — RAG answer                [open]
 *   GET  /documents              — list indexed docs         [admin]
 *   DELETE /documents            — purge all docs            [admin]
 *   GET  /health                 — liveness                  [open]
 */

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL   = "@cf/meta/llama-3.1-8b-instruct";
const EMBED_DIMS  = 768;

// ─── Helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
      "Access-Control-Expose-Headers": "X-Request-Id",
    },
  });
}

function err(msg, status = 400) {
  return json({ error: msg, status }, status);
}

function reqId() {
  return crypto.randomUUID();
}

function isAdmin(request, env) {
  const key = request.headers.get("X-Search-Admin-Key")
            || request.headers.get("Authorization")?.replace("Bearer ", "");
  return key === env.SEARCH_ADMIN_KEY;
}

// ─── D1 Schema Bootstrap ────────────────────────────────────────────────────

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT DEFAULT 'general',
      url         TEXT,
      metadata    TEXT DEFAULT '{}',
      indexed_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_docs_category ON search_documents(category);
    CREATE INDEX IF NOT EXISTS idx_search_docs_indexed  ON search_documents(indexed_at);
  `);
}

// ─── Embedding ──────────────────────────────────────────────────────────────

async function embed(ai, texts) {
  const input = Array.isArray(texts) ? texts : [texts];
  const result = await ai.run(EMBED_MODEL, { text: input });
  return result.data; // float32[][]
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

async function ingestDocs(env, docs) {
  await ensureSchema(env.SEARCH_DB);

  const now = new Date().toISOString();
  const vectors = [];
  const rows    = [];

  // Batch embed (all content strings at once)
  const texts = docs.map(d => `${d.title}\n\n${d.content}`);
  const embeddings = await embed(env.AI, texts);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const id  = doc.id || crypto.randomUUID();
    const emb = embeddings[i];

    vectors.push({
      id,
      values: emb,
      metadata: {
        title:    doc.title,
        category: doc.category || "general",
        url:      doc.url      || "",
      },
    });

    rows.push({
      id,
      title:     doc.title,
      content:   doc.content,
      category:  doc.category  || "general",
      url:       doc.url       || "",
      metadata:  JSON.stringify(doc.metadata || {}),
      indexed_at: now,
      updated_at: now,
    });
  }

  // Upsert vectors
  await env.VECTORIZE.upsert(vectors);

  // Upsert rows into D1
  const stmt = env.SEARCH_DB.prepare(`
    INSERT INTO search_documents (id, title, content, category, url, metadata, indexed_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(id) DO UPDATE SET
      title      = excluded.title,
      content    = excluded.content,
      category   = excluded.category,
      url        = excluded.url,
      metadata   = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  await env.SEARCH_DB.batch(
    rows.map(r =>
      stmt.bind(r.id, r.title, r.content, r.category, r.url, r.metadata, r.indexed_at, r.updated_at)
    )
  );

  return rows.map(r => ({ id: r.id, title: r.title }));
}

// ─── Semantic Search ────────────────────────────────────────────────────────

async function semanticSearch(env, query, options = {}) {
  const { top_k = 5, threshold = 0.5, category } = options;

  // Embed the query
  const [queryVec] = await embed(env.AI, query);

  // Query Vectorize
  const vectorQuery = { vector: queryVec, topK: top_k, returnMetadata: true };
  if (category) vectorQuery.filter = { category: { $eq: category } };

  const matches = await env.VECTORIZE.query(queryVec, {
    topK:           top_k,
    returnMetadata: "all",
    filter:         category ? { category: { $eq: category } } : undefined,
  });

  // Filter by threshold and fetch full content from D1
  const qualified = (matches.matches || []).filter(m => m.score >= threshold);
  if (qualified.length === 0) return [];

  const ids = qualified.map(m => `'${m.id}'`).join(",");
  const rows = await env.SEARCH_DB.prepare(
    `SELECT id, title, content, category, url, metadata FROM search_documents WHERE id IN (${ids})`
  ).all();

  const docMap = {};
  for (const row of (rows.results || [])) docMap[row.id] = row;

  return qualified.map(m => ({
    id:       m.id,
    score:    m.score,
    title:    m.metadata?.title    || docMap[m.id]?.title    || "",
    category: m.metadata?.category || docMap[m.id]?.category || "",
    url:      m.metadata?.url      || docMap[m.id]?.url      || "",
    excerpt:  docMap[m.id]?.content?.slice(0, 300) || "",
    metadata: docMap[m.id]?.metadata ? JSON.parse(docMap[m.id].metadata) : {},
  }));
}

// ─── RAG Answer ─────────────────────────────────────────────────────────────

async function ragAnswer(env, question, options = {}) {
  const { top_k = 4, category } = options;

  const results = await semanticSearch(env, question, { top_k, threshold: 0.45, category });

  if (results.length === 0) {
    return {
      answer: "I couldn't find relevant information in the knowledge base to answer that question.",
      sources: [],
    };
  }

  const context = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.excerpt}`)
    .join("\n\n---\n\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a helpful AI assistant. Answer the user's question using ONLY the provided context. " +
        "Be concise and accurate. If the context doesn't fully answer the question, say so. " +
        "Cite sources by number [1], [2], etc.",
    },
    {
      role: "user",
      content: `Context:\n${context}\n\nQuestion: ${question}`,
    },
  ];

  const llmResult = await env.AI.run(LLM_MODEL, { messages, max_tokens: 512 });

  return {
    answer:  llmResult.response || llmResult.result?.response || "No answer generated.",
    sources: results.map(r => ({ id: r.id, title: r.title, score: r.score, url: r.url })),
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
        },
      });
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (method === "GET" && path === "/health") {
      return json({
        status:  "ok",
        worker:  "ai-search",
        version: "1.1",
        models:  { embed: EMBED_MODEL, llm: LLM_MODEL },
        dims:    EMBED_DIMS,
        ts:      new Date().toISOString(),
      });
    }

    // ── POST /index ──────────────────────────────────────────────────────────
    if (method === "POST" && path === "/index") {
      if (!isAdmin(request, env)) return err("Unauthorized", 401);

      let body;
      try { body = await request.json(); } catch { return err("Invalid JSON"); }

      const docs = Array.isArray(body) ? body : [body];
      if (docs.length === 0)  return err("No documents provided");
      if (docs.length > 50)   return err("Max 50 documents per request");

      for (const d of docs) {
        if (!d.title)   return err("Each document requires a 'title' field");
        if (!d.content) return err("Each document requires a 'content' field");
      }

      try {
        const indexed = await ingestDocs(env, docs);
        return json({ indexed: indexed.length, documents: indexed }, 201);
      } catch (e) {
        console.error("Ingest error:", e);
        return err(`Ingestion failed: ${e.message}`, 500);
      }
    }

    // ── DELETE /index/:id ────────────────────────────────────────────────────
    const deleteMatch = path.match(/^\/index\/(.+)$/);
    if (method === "DELETE" && deleteMatch) {
      if (!isAdmin(request, env)) return err("Unauthorized", 401);
      const id = deleteMatch[1];

      try {
        await env.VECTORIZE.deleteByIds([id]);
        await env.SEARCH_DB.prepare("DELETE FROM search_documents WHERE id = ?").bind(id).run();
        return json({ deleted: id });
      } catch (e) {
        return err(`Delete failed: ${e.message}`, 500);
      }
    }

    // ── POST /search ─────────────────────────────────────────────────────────
    if (method === "POST" && path === "/search") {
      let body;
      try { body = await request.json(); } catch { return err("Invalid JSON"); }
      const { query, top_k = 5, threshold = 0.5, category } = body;
      if (!query) return err("'query' field is required");

      try {
        const results = await semanticSearch(env, query, { top_k, threshold, category });
        return json({ query, count: results.length, results });
      } catch (e) {
        return err(`Search failed: ${e.message}`, 500);
      }
    }

    // ── GET /search?q= ───────────────────────────────────────────────────────
    if (method === "GET" && path === "/search") {
      const query     = url.searchParams.get("q");
      const top_k     = parseInt(url.searchParams.get("top_k")    || "5");
      const threshold = parseFloat(url.searchParams.get("threshold") || "0.5");
      const category  = url.searchParams.get("category") || undefined;

      if (!query) return err("'q' query parameter is required");

      try {
        const results = await semanticSearch(env, query, { top_k, threshold, category });
        return json({ query, count: results.length, results });
      } catch (e) {
        return err(`Search failed: ${e.message}`, 500);
      }
    }

    // ── POST /ai/ask ─────────────────────────────────────────────────────────
    if (method === "POST" && path === "/ai/ask") {
      let body;
      try { body = await request.json(); } catch { return err("Invalid JSON"); }
      const { question, top_k = 4, category } = body;
      if (!question) return err("'question' field is required");

      try {
        const result = await ragAnswer(env, question, { top_k, category });
        return json({ question, ...result });
      } catch (e) {
        return err(`RAG failed: ${e.message}`, 500);
      }
    }

    // ── GET /documents ───────────────────────────────────────────────────────
    if (method === "GET" && path === "/documents") {
      if (!isAdmin(request, env)) return err("Unauthorized", 401);
      const page     = parseInt(url.searchParams.get("page")     || "1");
      const per_page = parseInt(url.searchParams.get("per_page") || "50");
      const category = url.searchParams.get("category");
      const offset   = (page - 1) * per_page;

      try {
        await ensureSchema(env.SEARCH_DB);
        const where = category ? "WHERE category = ?" : "";
        const args  = category ? [category, per_page, offset] : [per_page, offset];

        const rows = await env.SEARCH_DB.prepare(
          `SELECT id, title, category, url, indexed_at, updated_at FROM search_documents ${where} ORDER BY indexed_at DESC LIMIT ? OFFSET ?`
        ).bind(...args).all();

        const countRow = await env.SEARCH_DB.prepare(
          `SELECT COUNT(*) as total FROM search_documents ${where}`
        ).bind(...(category ? [category] : [])).first();

        return json({
          page,
          per_page,
          total:     countRow?.total || 0,
          documents: rows.results || [],
        });
      } catch (e) {
        return err(`List failed: ${e.message}`, 500);
      }
    }

    // ── DELETE /documents ────────────────────────────────────────────────────
    if (method === "DELETE" && path === "/documents") {
      if (!isAdmin(request, env)) return err("Unauthorized", 401);

      try {
        await ensureSchema(env.SEARCH_DB);
        const ids = await env.SEARCH_DB.prepare("SELECT id FROM search_documents").all();
        const allIds = (ids.results || []).map(r => r.id);

        if (allIds.length > 0) {
          await env.VECTORIZE.deleteByIds(allIds);
          await env.SEARCH_DB.prepare("DELETE FROM search_documents").run();
        }

        return json({ deleted: allIds.length, message: "All documents purged" });
      } catch (e) {
        return err(`Purge failed: ${e.message}`, 500);
      }
    }

    return err("Not Found", 404);
  },
};

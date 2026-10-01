/**
 * AI Search Worker v3.0
 * Sovereign Intelligence Layer — wwwknockoutforever.com
 * 
 * Stack:
 *   - Embedding:  @cf/baai/bge-base-en-v1.5  (768-dim)
 *   - Vectorize:  ai-search-index (cosine, 768-dim)
 *   - LLM (RAG):  @cf/meta/llama-3.1-8b-instruct
 *   - Catalog:    D1 (SEARCH_DB) — search_documents table
 *   - Auth:       SEARCH_ADMIN_KEY (secret) — admin routes
 *
 * Routes:
 *   GET  /health                   unauthenticated liveness
 *   GET  /search?q=<query>         semantic search (browser-friendly)
 *   POST /search                   semantic search { query, top_k?, threshold?, category?, include_content? }
 *   POST /ai/ask                   RAG: retrieve context + LLM answer { question, top_k?, category?, system_prompt? }
 *   POST /index                    ingest 1–100 docs  (admin)
 *   DELETE /index/:id              remove one doc (admin)
 *   GET  /documents                list indexed docs (admin, ?limit=&offset=&category=&q=)
 *   DELETE /documents              purge ALL docs + vectors (admin)
 *   GET  /stats                    index statistics (admin)
 *   POST /reindex/:id              re-embed one existing doc (admin)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Search-Admin-Key',
  'Access-Control-Expose-Headers': 'X-Request-Id, X-Latency-Ms',
};

const VERSION = '3.0.0';
const BUILD_DATE = '2026-10-01';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function err(msg, status = 400, code = 'BAD_REQUEST') {
  return json({ ok: false, error: { code, message: msg }, version: VERSION }, status);
}

function requestId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function isAdmin(req, env) {
  const key = env.SEARCH_ADMIN_KEY;
  if (!key) return false;
  const authHeader = req.headers.get('Authorization') || '';
  const keyHeader  = req.headers.get('X-Search-Admin-Key') || '';
  return keyHeader === key || authHeader === `Bearer ${key}`;
}

// ─── D1 Schema ───────────────────────────────────────────────────────────────

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      summary     TEXT,
      category    TEXT DEFAULT 'general',
      url         TEXT,
      author      TEXT,
      tags        TEXT,
      metadata    TEXT DEFAULT '{}',
      vector_id   TEXT,
      indexed_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_docs_category ON search_documents(category);
    CREATE INDEX IF NOT EXISTS idx_search_docs_indexed  ON search_documents(indexed_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      id UNINDEXED, title, content, category, author, tags,
      content='search_documents', content_rowid='rowid'
    );
  `);
}

// ─── Embedding ───────────────────────────────────────────────────────────────

async function embed(ai, text) {
  // Truncate to ~8000 chars to stay within model token limit
  const truncated = text.slice(0, 8000);
  const result = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [truncated] });
  return result.data[0]; // float[]
}

// ─── RAG — LLM answer ────────────────────────────────────────────────────────

async function ragAnswer(ai, question, contexts, systemPrompt) {
  const contextText = contexts
    .map((c, i) => `[${i + 1}] Title: ${c.title}\nContent: ${c.content.slice(0, 600)}`)
    .join('\n\n---\n\n');

  const system = systemPrompt ||
    `You are a precise AI assistant. Answer the user's question using ONLY the provided context documents.
If the context does not contain enough information, say so clearly.
Always cite which document(s) you used by referencing their [number].
Be concise, factual, and structured.`;

  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Context:\n${contextText}\n\n---\nQuestion: ${question}\n\nAnswer:`,
    },
  ];

  const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages,
    max_tokens: 768,
    temperature: 0.2,
  });

  return result.response || result.choices?.[0]?.message?.content || '';
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleHealth(env) {
  return json({
    ok: true,
    version: VERSION,
    build_date: BUILD_DATE,
    service: 'ai-search',
    domain: 'ai-search.wwwknockoutforever.com',
    capabilities: ['semantic-search', 'rag', 'fts', 'vectorize', 'workers-ai'],
  });
}

async function handleSearch(req, env) {
  const t0 = Date.now();
  const rid = requestId();

  let query, top_k = 8, threshold = 0.3, category, include_content = false;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    query = url.searchParams.get('q') || '';
    top_k = parseInt(url.searchParams.get('top_k') || '8', 10);
    threshold = parseFloat(url.searchParams.get('threshold') || '0.3');
    category = url.searchParams.get('category') || null;
    include_content = url.searchParams.get('include_content') === 'true';
  } else {
    const body = await req.json().catch(() => ({}));
    ({ query = '', top_k = 8, threshold = 0.3, category = null, include_content = false } = body);
  }

  if (!query || query.trim().length < 2)
    return err('query must be at least 2 characters', 400, 'QUERY_TOO_SHORT');

  top_k = Math.min(Math.max(top_k, 1), 50);

  // 1. Embed query
  const queryVec = await embed(env.AI, query);

  // 2. Vectorize search
  const vectorFilter = category ? { category: { $eq: category } } : undefined;
  const vResult = await env.VECTORIZE.query(queryVec, {
    topK: top_k,
    returnMetadata: 'all',
    filter: vectorFilter,
  });

  const hits = (vResult.matches || []).filter(m => m.score >= threshold);

  if (hits.length === 0) {
    return json({ ok: true, query, results: [], total: 0, latency_ms: Date.now() - t0 },
      200, { 'X-Request-Id': rid, 'X-Latency-Ms': String(Date.now() - t0) });
  }

  // 3. Fetch full docs from D1 for each hit
  const ids = hits.map(h => h.metadata?.doc_id || h.id).filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');
  const { results: docs } = await env.SEARCH_DB.prepare(
    `SELECT id, title, content, summary, category, url, author, tags, metadata, indexed_at
     FROM search_documents WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  const docMap = Object.fromEntries(docs.map(d => [d.id, d]));

  const results = hits.map(hit => {
    const docId = hit.metadata?.doc_id || hit.id;
    const doc   = docMap[docId] || {};
    return {
      id:         docId,
      score:      Math.round(hit.score * 10000) / 10000,
      title:      doc.title || hit.metadata?.title || 'Untitled',
      summary:    doc.summary || null,
      category:   doc.category || hit.metadata?.category || 'general',
      url:        doc.url || null,
      author:     doc.author || null,
      tags:       doc.tags ? JSON.parse(doc.tags) : [],
      indexed_at: doc.indexed_at || null,
      ...(include_content ? { content: doc.content || '' } : {}),
    };
  });

  return json(
    { ok: true, query, results, total: results.length, latency_ms: Date.now() - t0 },
    200,
    { 'X-Request-Id': rid, 'X-Latency-Ms': String(Date.now() - t0) }
  );
}

async function handleAsk(req, env) {
  const t0 = Date.now();
  const rid = requestId();
  const body = await req.json().catch(() => ({}));
  const { question, top_k = 5, category = null, system_prompt = null, threshold = 0.25 } = body;

  if (!question || question.trim().length < 4)
    return err('question must be at least 4 characters', 400, 'QUESTION_TOO_SHORT');

  // 1. Embed question
  const queryVec = await embed(env.AI, question);

  // 2. Retrieve top-k context
  const vectorFilter = category ? { category: { $eq: category } } : undefined;
  const vResult = await env.VECTORIZE.query(queryVec, {
    topK: Math.min(top_k, 20),
    returnMetadata: 'all',
    filter: vectorFilter,
  });

  const hits = (vResult.matches || []).filter(m => m.score >= threshold);

  if (hits.length === 0) {
    return json({
      ok: true, question,
      answer: "I don't have relevant documents to answer this question. Please index some content first.",
      sources: [], latency_ms: Date.now() - t0,
    }, 200, { 'X-Request-Id': rid });
  }

  // 3. Fetch docs
  const ids = hits.map(h => h.metadata?.doc_id || h.id).filter(Boolean);
  const placeholders = ids.map(() => '?').join(',');
  const { results: docs } = await env.SEARCH_DB.prepare(
    `SELECT id, title, content, url FROM search_documents WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  const docMap = Object.fromEntries(docs.map(d => [d.id, d]));
  const contexts = hits.map(hit => {
    const docId = hit.metadata?.doc_id || hit.id;
    return { ...docMap[docId], score: hit.score };
  }).filter(c => c.title);

  // 4. RAG answer
  const answer = await ragAnswer(env.AI, question, contexts, system_prompt);

  const sources = contexts.map(c => ({
    id: c.id, title: c.title, url: c.url || null, score: Math.round(c.score * 10000) / 10000,
  }));

  return json(
    { ok: true, question, answer, sources, latency_ms: Date.now() - t0 },
    200,
    { 'X-Request-Id': rid, 'X-Latency-Ms': String(Date.now() - t0) }
  );
}

async function handleIndex(req, env) {
  const body = await req.json().catch(() => ({}));
  const docs  = Array.isArray(body) ? body : body.documents ? body.documents : [body];

  if (docs.length === 0)  return err('No documents provided');
  if (docs.length > 100)  return err('Max 100 documents per request', 400, 'TOO_MANY_DOCS');

  await ensureSchema(env.SEARCH_DB);

  const results = [];
  const vectors = [];
  const now = new Date().toISOString();

  for (const doc of docs) {
    if (!doc.title || !doc.content)
      return err(`Document missing required fields: title, content. Got: ${JSON.stringify(Object.keys(doc))}`);

    const id       = doc.id || crypto.randomUUID();
    const category = doc.category || 'general';
    const summary  = doc.summary || doc.content.slice(0, 200).replace(/\s+/g, ' ') + (doc.content.length > 200 ? '...' : '');
    const textToEmbed = `${doc.title}\n\n${doc.content}`;

    // Embed
    const vec = await embed(env.AI, textToEmbed);

    vectors.push({
      id: id,
      values: vec,
      metadata: {
        doc_id:   id,
        title:    doc.title.slice(0, 200),
        category: category,
        indexed_at: now,
      },
    });

    // Upsert D1
    await env.SEARCH_DB.prepare(`
      INSERT INTO search_documents (id, title, content, summary, category, url, author, tags, metadata, vector_id, indexed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, content=excluded.content, summary=excluded.summary,
        category=excluded.category, url=excluded.url, author=excluded.author,
        tags=excluded.tags, metadata=excluded.metadata, updated_at=excluded.updated_at
    `).bind(
      id, doc.title, doc.content, summary, category,
      doc.url || null, doc.author || null,
      doc.tags ? JSON.stringify(doc.tags) : null,
      doc.metadata ? JSON.stringify(doc.metadata) : '{}',
      id, now, now
    ).run();

    results.push({ id, title: doc.title, category });
  }

  // Upsert vectors in batch
  await env.VECTORIZE.upsert(vectors);

  return json({ ok: true, indexed: results.length, documents: results }, 201);
}

async function handleDeleteDoc(id, env) {
  // Remove from Vectorize
  await env.VECTORIZE.deleteByIds([id]).catch(() => {});
  // Remove from D1
  const res = await env.SEARCH_DB.prepare(
    'DELETE FROM search_documents WHERE id = ? RETURNING id, title'
  ).bind(id).first();

  if (!res) return err(`Document ${id} not found`, 404, 'NOT_FOUND');
  return json({ ok: true, deleted: { id: res.id, title: res.title } });
}

async function handleListDocuments(req, env) {
  const url    = new URL(req.url);
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const cat    = url.searchParams.get('category') || null;
  const q      = url.searchParams.get('q') || null;

  let where = '';
  const binds = [];
  if (cat) { where += ' WHERE category = ?'; binds.push(cat); }
  if (q)   { where += (where ? ' AND' : ' WHERE') + ' (title LIKE ? OR content LIKE ?)'; binds.push(`%${q}%`, `%${q}%`); }

  const { results } = await env.SEARCH_DB.prepare(
    `SELECT id, title, summary, category, url, author, tags, indexed_at, updated_at
     FROM search_documents${where} ORDER BY indexed_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  const { results: [{ total }] } = await env.SEARCH_DB.prepare(
    `SELECT COUNT(*) AS total FROM search_documents${where}`
  ).bind(...binds).all();

  return json({ ok: true, documents: results, total, limit, offset });
}

async function handlePurge(env) {
  await env.SEARCH_DB.prepare('DELETE FROM search_documents').run().catch(() => {});
  // Vectorize doesn't have a bulk-delete, so we fetch all IDs and delete
  // (For large indexes, do this in pages — here up to 1000 IDs)
  const { results } = await env.SEARCH_DB.prepare('SELECT id FROM search_documents LIMIT 1000').all().catch(() => ({ results: [] }));
  if (results.length) {
    await env.VECTORIZE.deleteByIds(results.map(r => r.id)).catch(() => {});
  }
  await env.SEARCH_DB.prepare('DELETE FROM search_documents').run();
  return json({ ok: true, message: 'All documents and vectors purged' });
}

async function handleStats(env) {
  await ensureSchema(env.SEARCH_DB);
  const { results: [row] } = await env.SEARCH_DB.prepare(`
    SELECT
      COUNT(*)                              AS total_documents,
      COUNT(DISTINCT category)              AS categories,
      MIN(indexed_at)                       AS oldest_doc,
      MAX(indexed_at)                       AS newest_doc,
      AVG(LENGTH(content))                  AS avg_content_length
    FROM search_documents
  `).all();

  const { results: cats } = await env.SEARCH_DB.prepare(
    'SELECT category, COUNT(*) as count FROM search_documents GROUP BY category ORDER BY count DESC'
  ).all();

  return json({
    ok: true,
    version: VERSION,
    stats: {
      total_documents:   row.total_documents,
      categories:        row.categories,
      oldest_doc:        row.oldest_doc,
      newest_doc:        row.newest_doc,
      avg_content_length: Math.round(row.avg_content_length || 0),
      by_category:       cats,
    },
    models: {
      embedding: '@cf/baai/bge-base-en-v1.5 (768-dim)',
      llm:       '@cf/meta/llama-3.1-8b-instruct',
    },
  });
}

async function handleReindex(id, env) {
  const doc = await env.SEARCH_DB.prepare(
    'SELECT id, title, content, category FROM search_documents WHERE id = ?'
  ).bind(id).first();

  if (!doc) return err(`Document ${id} not found`, 404, 'NOT_FOUND');

  const vec = await embed(env.AI, `${doc.title}\n\n${doc.content}`);
  await env.VECTORIZE.upsert([{
    id: doc.id,
    values: vec,
    metadata: { doc_id: doc.id, title: doc.title.slice(0, 200), category: doc.category },
  }]);

  const now = new Date().toISOString();
  await env.SEARCH_DB.prepare('UPDATE search_documents SET updated_at = ? WHERE id = ?').bind(now, id).run();

  return json({ ok: true, reindexed: { id: doc.id, title: doc.title } });
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url      = new URL(request.url);
    const path     = url.pathname;
    const method   = request.method;
    const admin    = isAdmin(request, env);

    try {
      await ensureSchema(env.SEARCH_DB);

      // ── Public routes ──────────────────────────────────
      if (path === '/health' && method === 'GET')
        return handleHealth(env);

      if (path === '/search' && (method === 'GET' || method === 'POST'))
        return handleSearch(request, env);

      if (path === '/ai/ask' && method === 'POST')
        return handleAsk(request, env);

      // ── Admin routes ────────────────────────────────────
      if (!admin && ['/index', '/documents', '/stats'].some(p => path.startsWith(p)))
        return err('Unauthorized — provide X-Search-Admin-Key or Bearer token', 401, 'UNAUTHORIZED');

      if (path === '/index' && method === 'POST')
        return handleIndex(request, env);

      const deleteMatch = path.match(/^\/index\/(.+)$/);
      if (deleteMatch && method === 'DELETE') {
        if (!admin) return err('Unauthorized', 401, 'UNAUTHORIZED');
        return handleDeleteDoc(deleteMatch[1], env);
      }

      if (path === '/documents' && method === 'GET') {
        if (!admin) return err('Unauthorized', 401, 'UNAUTHORIZED');
        return handleListDocuments(request, env);
      }

      if (path === '/documents' && method === 'DELETE') {
        if (!admin) return err('Unauthorized', 401, 'UNAUTHORIZED');
        return handlePurge(env);
      }

      if (path === '/stats' && method === 'GET') {
        if (!admin) return err('Unauthorized', 401, 'UNAUTHORIZED');
        return handleStats(env);
      }

      const reindexMatch = path.match(/^\/reindex\/(.+)$/);
      if (reindexMatch && method === 'POST') {
        if (!admin) return err('Unauthorized', 401, 'UNAUTHORIZED');
        return handleReindex(reindexMatch[1], env);
      }

      return err(`Unknown route: ${method} ${path}`, 404, 'NOT_FOUND');

    } catch (e) {
      console.error('ai-search error:', e);
      return json({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: e.message },
        version: VERSION,
      }, 500);
    }
  },
};

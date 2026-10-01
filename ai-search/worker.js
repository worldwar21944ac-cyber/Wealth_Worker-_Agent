/**
 * ai-search — Cloudflare Worker v1.0
 * Semantic search + RAG using Workers AI (BGE-base embeddings) + Vectorize + D1
 *
 * Routes:
 *   POST /index              — ingest 1-50 docs  (admin: X-Search-Admin-Key header)
 *   DELETE /index/:id        — remove one doc     (admin)
 *   POST /search             — semantic search    { query, top_k?, threshold?, category? }
 *   GET  /search?q=          — browser-friendly   ?q=...&top_k=5&category=...
 *   POST /ai/ask             — RAG answer          { question, top_k?, category? }
 *   GET  /documents          — list indexed docs  (admin)
 *   DELETE /documents        — purge all docs     (admin)
 *   GET  /health             — liveness (no auth)
 *
 * Bindings (wrangler.toml):
 *   AI          — Workers AI binding
 *   VECTORIZE   — Vectorize index  (ai-search-index, 768-dim, cosine)
 *   SEARCH_DB   — D1 database      (bervashun-audit, id: f2fe6105-b552-42b4-a2ca-9d2a349861da)
 *
 * Secrets:
 *   SEARCH_ADMIN_KEY  — admin key for write/delete endpoints
 *
 * Embedding model:  @cf/baai/bge-base-en-v1.5  (768 dim)
 * LLM (RAG):        @cf/meta/llama-3.1-8b-instruct
 */

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const LLM_MODEL   = '@cf/meta/llama-3.1-8b-instruct';
const MAX_BATCH   = 50;
const DEFAULT_TOP_K = 5;
const DEFAULT_THRESHOLD = 0.4;

// ─── CORS helpers ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Search-Admin-Key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function err(msg, status = 400) {
  return json({ success: false, error: msg }, status);
}

// ─── D1 schema bootstrap ──────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_documents (
  doc_id      TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT DEFAULT 'general',
  url         TEXT,
  metadata    TEXT DEFAULT '{}',
  indexed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

async function ensureSchema(env) {
  try {
    await env.SEARCH_DB.exec(SCHEMA);
  } catch (_) {
    // table already exists — ignore
  }
}

// ─── Admin auth ───────────────────────────────────────────────────────────────
function isAdmin(req, env) {
  const key = req.headers.get('X-Search-Admin-Key') || req.headers.get('Authorization')?.replace('Bearer ', '');
  return key && key === env.SEARCH_ADMIN_KEY;
}

// ─── Embedding helper ─────────────────────────────────────────────────────────
async function embed(env, texts) {
  const resp = await env.AI.run(EMBED_MODEL, { text: texts });
  return resp.data; // float[][]
}

// ─── ROUTE: POST /index ───────────────────────────────────────────────────────
async function handleIndex(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const docs = Array.isArray(body) ? body : [body];
  if (!docs.length)           return err('No documents provided');
  if (docs.length > MAX_BATCH) return err(`Max ${MAX_BATCH} docs per call`);

  const results = [];
  const errors  = [];

  // Validate
  for (const doc of docs) {
    if (!doc.id || !doc.title || !doc.content) {
      errors.push({ id: doc.id || '(missing)', error: 'id, title, content are required' });
    }
  }
  if (errors.length) return json({ success: false, errors }, 400);

  // Embed all in one batch call
  const texts = docs.map(d => `${d.title}\n\n${d.content}`);
  let embeddings;
  try {
    embeddings = await embed(env, texts);
  } catch (e) {
    return err(`Embedding failed: ${e.message}`, 502);
  }

  // Upsert D1 + Vectorize
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const vec = embeddings[i];

    try {
      // D1 upsert
      await env.SEARCH_DB.prepare(`
        INSERT INTO search_documents (doc_id, title, content, category, url, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET
          title=excluded.title,
          content=excluded.content,
          category=excluded.category,
          url=excluded.url,
          metadata=excluded.metadata,
          indexed_at=CURRENT_TIMESTAMP
      `).bind(
        doc.id,
        doc.title,
        doc.content,
        doc.category || 'general',
        doc.url || null,
        JSON.stringify(doc.metadata || {}),
      ).run();

      // Vectorize upsert
      await env.VECTORIZE.upsert([{
        id:       doc.id,
        values:   vec,
        metadata: {
          title:    doc.title,
          category: doc.category || 'general',
          url:      doc.url || '',
        },
      }]);

      results.push({ id: doc.id, status: 'indexed' });
    } catch (e) {
      errors.push({ id: doc.id, error: e.message });
    }
  }

  return json({
    success: true,
    indexed: results.length,
    errors:  errors.length,
    results,
    ...(errors.length ? { errors } : {}),
  });
}

// ─── ROUTE: DELETE /index/:id ─────────────────────────────────────────────────
async function handleDeleteDoc(req, env, docId) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  try {
    await env.SEARCH_DB.prepare('DELETE FROM search_documents WHERE doc_id = ?').bind(docId).run();
    await env.VECTORIZE.deleteByIds([docId]);
    return json({ success: true, deleted: docId });
  } catch (e) {
    return err(e.message, 500);
  }
}

// ─── ROUTE: POST /search  /  GET /search?q= ──────────────────────────────────
async function handleSearch(req, env, url) {
  await ensureSchema(env);

  let query, topK, threshold, category;

  if (req.method === 'GET') {
    query     = url.searchParams.get('q') || '';
    topK      = parseInt(url.searchParams.get('top_k')  || String(DEFAULT_TOP_K));
    threshold = parseFloat(url.searchParams.get('threshold') || String(DEFAULT_THRESHOLD));
    category  = url.searchParams.get('category') || null;
  } else {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }
    query     = body.query      || '';
    topK      = body.top_k      || DEFAULT_TOP_K;
    threshold = body.threshold  ?? DEFAULT_THRESHOLD;
    category  = body.category   || null;
  }

  if (!query.trim()) return err('query is required');

  // Embed query
  let qVec;
  try {
    const embs = await embed(env, [query]);
    qVec = embs[0];
  } catch (e) {
    return err(`Embedding failed: ${e.message}`, 502);
  }

  // Vectorize query
  const filter = category ? { category: { $eq: category } } : undefined;
  let vecResults;
  try {
    vecResults = await env.VECTORIZE.query(qVec, {
      topK:            topK,
      returnMetadata:  'all',
      ...(filter ? { filter } : {}),
    });
  } catch (e) {
    return err(`Vector search failed: ${e.message}`, 502);
  }

  const matches = (vecResults.matches || []).filter(m => m.score >= threshold);

  // Enrich from D1
  const enriched = await Promise.all(matches.map(async m => {
    let extra = null;
    try {
      const row = await env.SEARCH_DB.prepare(
        'SELECT title, content, category, url, metadata FROM search_documents WHERE doc_id = ?'
      ).bind(m.id).first();
      if (row) {
        extra = {
          content:  row.content,
          category: row.category,
          url:      row.url,
          metadata: JSON.parse(row.metadata || '{}'),
        };
      }
    } catch (_) {}

    return {
      id:       m.id,
      score:    Math.round(m.score * 1000) / 1000,
      title:    m.metadata?.title || extra?.title || m.id,
      category: extra?.category || m.metadata?.category || 'general',
      url:      extra?.url || m.metadata?.url || null,
      excerpt:  extra?.content ? extra.content.slice(0, 280) + (extra.content.length > 280 ? '…' : '') : null,
      metadata: extra?.metadata || {},
    };
  }));

  return json({
    success: true,
    query,
    count:   enriched.length,
    results: enriched,
  });
}

// ─── ROUTE: POST /ai/ask ─────────────────────────────────────────────────────
async function handleAsk(req, env) {
  await ensureSchema(env);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const { question, top_k = DEFAULT_TOP_K, category } = body;
  if (!question?.trim()) return err('question is required');

  // Embed question
  let qVec;
  try {
    const embs = await embed(env, [question]);
    qVec = embs[0];
  } catch (e) {
    return err(`Embedding failed: ${e.message}`, 502);
  }

  // Retrieve context from Vectorize
  const filter = category ? { category: { $eq: category } } : undefined;
  let vecResults;
  try {
    vecResults = await env.VECTORIZE.query(qVec, {
      topK:           top_k,
      returnMetadata: 'all',
      ...(filter ? { filter } : {}),
    });
  } catch (e) {
    return err(`Vector search failed: ${e.message}`, 502);
  }

  // Fetch full content from D1
  const contextParts = [];
  const sources = [];
  for (const m of (vecResults.matches || [])) {
    try {
      const row = await env.SEARCH_DB.prepare(
        'SELECT title, content, url FROM search_documents WHERE doc_id = ?'
      ).bind(m.id).first();
      if (row) {
        contextParts.push(`### ${row.title}\n${row.content}`);
        sources.push({ id: m.id, title: row.title, url: row.url, score: m.score });
      }
    } catch (_) {}
  }

  const context = contextParts.join('\n\n---\n\n') || 'No relevant documents found.';

  // LLM answer
  const prompt = `You are a precise, helpful assistant. Answer the question using ONLY the context below.
If the answer is not in the context, say "I don't have enough information to answer that."

<context>
${context}
</context>

Question: ${question}
Answer:`;

  let answer = '';
  try {
    const llmResp = await env.AI.run(LLM_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
    });
    answer = llmResp.response || llmResp.result?.response || '';
  } catch (e) {
    return err(`LLM failed: ${e.message}`, 502);
  }

  return json({
    success: true,
    question,
    answer: answer.trim(),
    sources,
  });
}

// ─── ROUTE: GET /documents ────────────────────────────────────────────────────
async function handleListDocuments(req, env, url) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  const limit  = parseInt(url.searchParams.get('limit')  || '100');
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const cat    = url.searchParams.get('category') || null;

  try {
    const query = cat
      ? 'SELECT doc_id, title, category, url, indexed_at FROM search_documents WHERE category = ? ORDER BY indexed_at DESC LIMIT ? OFFSET ?'
      : 'SELECT doc_id, title, category, url, indexed_at FROM search_documents ORDER BY indexed_at DESC LIMIT ? OFFSET ?';

    const result = cat
      ? await env.SEARCH_DB.prepare(query).bind(cat, limit, offset).all()
      : await env.SEARCH_DB.prepare(query).bind(limit, offset).all();

    const countResult = cat
      ? await env.SEARCH_DB.prepare('SELECT COUNT(*) as total FROM search_documents WHERE category = ?').bind(cat).first()
      : await env.SEARCH_DB.prepare('SELECT COUNT(*) as total FROM search_documents').first();

    return json({
      success: true,
      total:   countResult?.total || 0,
      limit,
      offset,
      documents: result.results || [],
    });
  } catch (e) {
    return err(e.message, 500);
  }
}

// ─── ROUTE: DELETE /documents ─────────────────────────────────────────────────
async function handlePurgeDocuments(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  try {
    // Get all IDs first
    const rows = await env.SEARCH_DB.prepare('SELECT doc_id FROM search_documents').all();
    const ids  = (rows.results || []).map(r => r.doc_id);

    await env.SEARCH_DB.prepare('DELETE FROM search_documents').run();
    if (ids.length) await env.VECTORIZE.deleteByIds(ids);

    return json({ success: true, purged: ids.length });
  } catch (e) {
    return err(e.message, 500);
  }
}

// ─── ROUTE: GET /health ───────────────────────────────────────────────────────
function handleHealth() {
  return json({
    success: true,
    service: 'ai-search',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    models: { embedding: EMBED_MODEL, llm: LLM_MODEL },
  });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env, _ctx) {
    const url    = new URL(req.url);
    const path   = url.pathname.replace(/\/$/, '') || '/';
    const method = req.method.toUpperCase();

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (path === '/health' && method === 'GET') {
      return handleHealth();
    }

    // ── POST /index ──────────────────────────────────────────────────────────
    if (path === '/index' && method === 'POST') {
      return handleIndex(req, env);
    }

    // ── DELETE /index/:id ────────────────────────────────────────────────────
    const deleteMatch = path.match(/^\/index\/(.+)$/);
    if (deleteMatch && method === 'DELETE') {
      return handleDeleteDoc(req, env, decodeURIComponent(deleteMatch[1]));
    }

    // ── POST /search  OR  GET /search?q= ────────────────────────────────────
    if (path === '/search' && (method === 'POST' || method === 'GET')) {
      return handleSearch(req, env, url);
    }

    // ── POST /ai/ask ─────────────────────────────────────────────────────────
    if (path === '/ai/ask' && method === 'POST') {
      return handleAsk(req, env);
    }

    // ── GET /documents ───────────────────────────────────────────────────────
    if (path === '/documents' && method === 'GET') {
      return handleListDocuments(req, env, url);
    }

    // ── DELETE /documents ────────────────────────────────────────────────────
    if (path === '/documents' && method === 'DELETE') {
      return handlePurgeDocuments(req, env);
    }

    return err('Not Found', 404);
  },
};

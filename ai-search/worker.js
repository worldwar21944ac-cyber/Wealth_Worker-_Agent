/**
 * ai-search Worker v3.0
 * Cloudflare Workers AI + Vectorize + D1
 * Semantic search + RAG (Retrieval-Augmented Generation)
 *
 * Bindings required:
 *   AI             – Workers AI binding
 *   VECTORIZE      – Vectorize index (768-dim cosine)
 *   SEARCH_DB      – D1 database for document metadata
 *   SEARCH_ADMIN_KEY – Secret (admin auth)
 *
 * Routes:
 *   GET  /health
 *   POST /index              (admin)
 *   DELETE /index/:id        (admin)
 *   POST /search             { query, top_k?, threshold?, category? }
 *   GET  /search?q=          (browser-friendly)
 *   POST /ai/ask             { question, top_k?, category? }
 *   GET  /documents          (admin, ?limit=&offset=&category=)
 *   DELETE /documents        (admin) – purge all
 *   GET  /stats              (admin)
 */

const EMBED_MODEL  = '@cf/baai/bge-base-en-v1.5';
const LLM_MODEL    = '@cf/meta/llama-3.1-8b-instruct';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Search-Admin-Key',
};

// ─── D1 bootstrap ────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT DEFAULT 'general',
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sd_category ON search_documents(category);
CREATE INDEX IF NOT EXISTS idx_sd_created  ON search_documents(created_at);
`;

async function ensureSchema(db) {
  for (const stmt of SCHEMA.trim().split(';').map(s => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function isAdmin(req, env) {
  const key = req.headers.get('X-Search-Admin-Key')
    || (req.headers.get('Authorization') || '').replace('Bearer ', '');
  return key === env.SEARCH_ADMIN_KEY;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ─── Embedding helper ─────────────────────────────────────────────────────────
async function embed(ai, text) {
  const res = await ai.run(EMBED_MODEL, { text: [text] });
  return res.data[0];
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/health') {
      return json({
        status:  'ok',
        version: '3.0',
        models:  { embed: EMBED_MODEL, llm: LLM_MODEL },
        ts:      new Date().toISOString(),
      });
    }

    // Ensure D1 schema exists (cheap no-op after first call)
    try { await ensureSchema(env.SEARCH_DB); }
    catch (e) { /* non-fatal — D1 might already be set up */ }

    // ── POST /index ──────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/index') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);

      let body;
      try { body = await request.json(); }
      catch { return err('Invalid JSON'); }

      const docs = Array.isArray(body) ? body : [body];
      if (docs.length === 0 || docs.length > 50) return err('Send 1–50 documents per call');

      const results = [];
      for (const doc of docs) {
        const { id, title, content, category = 'general', metadata = {} } = doc;
        if (!id || !title || !content) {
          results.push({ id, status: 'error', reason: 'id, title, content are required' });
          continue;
        }

        try {
          // Embed content
          const vector = await embed(env.AI, `${title}\n\n${content}`);

          // Upsert vector in Vectorize
          await env.VECTORIZE.upsert([{
            id,
            values: vector,
            metadata: { title, category, doc_id: id },
          }]);

          // Upsert document metadata in D1
          await env.SEARCH_DB
            .prepare(`INSERT INTO search_documents (id, title, content, category, metadata, updated_at)
                      VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
                      ON CONFLICT(id) DO UPDATE SET
                        title=excluded.title, content=excluded.content,
                        category=excluded.category, metadata=excluded.metadata,
                        updated_at=excluded.updated_at`)
            .bind(id, title, content, category, JSON.stringify(metadata))
            .run();

          results.push({ id, status: 'indexed' });
        } catch (e) {
          results.push({ id, status: 'error', reason: e.message });
        }
      }

      return json({ indexed: results.filter(r => r.status === 'indexed').length, results });
    }

    // ── DELETE /index/:id ────────────────────────────────────────────────────
    const deleteMatch = path.match(/^\/index\/(.+)$/);
    if (method === 'DELETE' && deleteMatch) {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      const id = decodeURIComponent(deleteMatch[1]);
      try {
        await env.VECTORIZE.deleteByIds([id]);
        await env.SEARCH_DB.prepare('DELETE FROM search_documents WHERE id = ?').bind(id).run();
        return json({ deleted: id });
      } catch (e) {
        return err(e.message, 500);
      }
    }

    // ── POST /search ─────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/search') {
      let body;
      try { body = await request.json(); }
      catch { return err('Invalid JSON'); }

      const { query, top_k = 5, threshold = 0.5, category } = body;
      if (!query) return err('query is required');

      return performSearch(env, query, { top_k, threshold, category });
    }

    // ── GET /search?q= ───────────────────────────────────────────────────────
    if (method === 'GET' && path === '/search') {
      const query     = url.searchParams.get('q');
      const top_k     = parseInt(url.searchParams.get('top_k')    || '5',  10);
      const threshold = parseFloat(url.searchParams.get('threshold') || '0.5');
      const category  = url.searchParams.get('category') || undefined;
      if (!query) return err('q param is required');
      return performSearch(env, query, { top_k, threshold, category });
    }

    // ── POST /ai/ask ─────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/ai/ask') {
      let body;
      try { body = await request.json(); }
      catch { return err('Invalid JSON'); }

      const { question, top_k = 4, category } = body;
      if (!question) return err('question is required');

      try {
        // 1. Retrieve relevant docs
        const vector  = await embed(env.AI, question);
        const vFilter = category ? { category: { $eq: category } } : undefined;
        const vRes    = await env.VECTORIZE.query(vector, {
          topK:           top_k,
          returnValues:   false,
          returnMetadata: 'indexed',
          filter:         vFilter,
        });

        const hits = vRes.matches || [];
        const ids  = hits.map(h => h.id);

        let context = '';
        if (ids.length > 0) {
          const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
          const rows = await env.SEARCH_DB
            .prepare(`SELECT title, content FROM search_documents WHERE id IN (${placeholders})`)
            .bind(...ids)
            .all();
          context = (rows.results || [])
            .map(r => `## ${r.title}\n${r.content}`)
            .join('\n\n---\n\n');
        }

        // 2. Generate answer
        const systemPrompt = context
          ? `You are a helpful AI assistant. Use the following retrieved documents to answer the question.\n\n${context}`
          : 'You are a helpful AI assistant.';

        const llmRes = await env.AI.run(LLM_MODEL, {
          messages: [
            { role: 'system',  content: systemPrompt },
            { role: 'user',    content: question },
          ],
        });

        return json({
          question,
          answer:   llmRes.response,
          sources:  hits.map(h => ({ id: h.id, score: h.score, title: h.metadata?.title })),
          context_docs: ids.length,
        });
      } catch (e) {
        return err(e.message, 500);
      }
    }

    // ── GET /documents ───────────────────────────────────────────────────────
    if (method === 'GET' && path === '/documents') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      const limit    = parseInt(url.searchParams.get('limit')  || '20', 10);
      const offset   = parseInt(url.searchParams.get('offset') || '0',  10);
      const category = url.searchParams.get('category');

      try {
        const where = category ? 'WHERE category = ?' : '';
        const binds = category ? [category, limit, offset] : [limit, offset];
        const rows  = await env.SEARCH_DB
          .prepare(`SELECT id, title, category, metadata, created_at, updated_at FROM search_documents ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
          .bind(...binds)
          .all();

        const countRes = await env.SEARCH_DB
          .prepare(`SELECT COUNT(*) as cnt FROM search_documents ${where}`)
          .bind(...(category ? [category] : []))
          .first();

        return json({ total: countRes.cnt, limit, offset, documents: rows.results || [] });
      } catch (e) {
        return err(e.message, 500);
      }
    }

    // ── DELETE /documents (purge all) ────────────────────────────────────────
    if (method === 'DELETE' && path === '/documents') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      try {
        // Fetch all IDs to delete from Vectorize
        const rows = await env.SEARCH_DB
          .prepare('SELECT id FROM search_documents')
          .all();
        const ids = (rows.results || []).map(r => r.id);
        if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids);

        await env.SEARCH_DB.prepare('DELETE FROM search_documents').run();
        return json({ purged: ids.length });
      } catch (e) {
        return err(e.message, 500);
      }
    }

    // ── GET /stats ───────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/stats') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      try {
        const total     = await env.SEARCH_DB.prepare('SELECT COUNT(*) as cnt FROM search_documents').first();
        const cats      = await env.SEARCH_DB.prepare('SELECT category, COUNT(*) as cnt FROM search_documents GROUP BY category').all();
        const recent    = await env.SEARCH_DB.prepare('SELECT id, title, category, created_at FROM search_documents ORDER BY created_at DESC LIMIT 5').all();
        return json({
          total_documents: total.cnt,
          categories:      cats.results || [],
          recent:          recent.results || [],
          models:          { embed: EMBED_MODEL, llm: LLM_MODEL },
        });
      } catch (e) {
        return err(e.message, 500);
      }
    }

    return json({ error: 'Not found', path, method }, 404);
  },
};

// ─── Shared search logic ──────────────────────────────────────────────────────
async function performSearch(env, query, { top_k = 5, threshold = 0.5, category }) {
  try {
    const vector  = await embed(env.AI, query);
    const vFilter = category ? { category: { $eq: category } } : undefined;

    const vRes = await env.VECTORIZE.query(vector, {
      topK:           top_k,
      returnValues:   false,
      returnMetadata: 'indexed',
      filter:         vFilter,
    });

    const hits = (vRes.matches || []).filter(h => h.score >= threshold);
    const ids  = hits.map(h => h.id);

    let docs = [];
    if (ids.length > 0) {
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
      const rows = await env.SEARCH_DB
        .prepare(`SELECT id, title, content, category, metadata, created_at FROM search_documents WHERE id IN (${placeholders})`)
        .bind(...ids)
        .all();
      // Re-order to match Vectorize ranking
      const docMap = {};
      (rows.results || []).forEach(r => { docMap[r.id] = r; });
      docs = ids.map(id => ({
        ...(docMap[id] || { id }),
        score: hits.find(h => h.id === id)?.score,
      }));
    }

    return json({
      query,
      total:   docs.length,
      results: docs,
    });
  } catch (e) {
    return json({ error: e.message }, 500, CORS_HEADERS);
  }
}

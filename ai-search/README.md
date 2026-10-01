# ai-search Worker v3.0

Cloudflare Worker with semantic search + RAG (Retrieval-Augmented Generation).

## Stack
- **Embedding**: `@cf/baai/bge-base-en-v1.5` (768-dim, Workers AI)
- **Vector DB**: Cloudflare Vectorize (`ai-search-index`, cosine metric)
- **LLM (RAG)**: `@cf/meta/llama-3.1-8b-instruct` (Workers AI)
- **Metadata DB**: D1 (`bervashun-audit`)
- **Domain**: `https://ai-search.wwwknockoutforever.com`

## Deploy

```bash
# From your terminal (requires CF API token)
bash deploy-now.sh <YOUR_CLOUDFLARE_API_TOKEN>

# OR via GitHub Actions: add CLOUDFLARE_API_TOKEN to repo secrets
# Settings → Secrets and variables → Actions → New repository secret
```

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Public | Liveness check |
| POST | `/index` | Admin | Ingest 1-50 documents |
| DELETE | `/index/:id` | Admin | Remove a document |
| POST | `/search` | Public | Semantic vector search |
| GET | `/search?q=` | Public | Browser-friendly search |
| POST | `/ai/ask` | Public | RAG: search + LLM answer |
| GET | `/documents` | Admin | List all documents |
| DELETE | `/documents` | Admin | Purge all |
| GET | `/stats` | Admin | Usage statistics |

## Auth

Admin routes require:
- Header: `X-Search-Admin-Key: search-admin-bervashun-2026`
- OR: `Authorization: Bearer search-admin-bervashun-2026`

## Examples

```bash
BASE="https://ai-search.wwwknockoutforever.com"
KEY="search-admin-bervashun-2026"

# Health
curl $BASE/health

# Index a document
curl -X POST $BASE/index \
  -H "Content-Type: application/json" \
  -H "X-Search-Admin-Key: $KEY" \
  -d '[{"id":"doc-1","title":"My Document","content":"...","category":"general"}]'

# Semantic search
curl -X POST $BASE/search \
  -H "Content-Type: application/json" \
  -d '{"query":"your search query","top_k":5,"threshold":0.5}'

# Browser search
curl "$BASE/search?q=your+query&top_k=5"

# Ask AI (RAG)
curl -X POST $BASE/ai/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What is ...?","top_k":4}'

# Stats
curl $BASE/stats -H "X-Search-Admin-Key: $KEY"
```

## Bindings

```toml
[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "ai-search-index"

[[d1_databases]]
binding = "SEARCH_DB"
database_name = "bervashun-audit"
database_id = "f2fe6105-b552-42b4-a2ca-9d2a349861da"
```

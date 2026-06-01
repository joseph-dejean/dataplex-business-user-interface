# Knowledge Catalog Discovery Agent — Service

A standalone Python ([Google ADK](https://adk.dev)) microservice that wraps the
[Knowledge Catalog Discovery Agent](https://github.com/GoogleCloudPlatform/dataplex-labs/tree/main/knowledge_catalog_discovery_agent)
and exposes it over HTTP so the (Node.js) Business User Interface backend can use
it for **agentic semantic search**.

## Why a separate service?

The discovery agent is built on Google's **ADK**, which is Python-only, while the
app backend is Node.js. Rather than re-implement the agent, we run it as its own
Cloud Run service and the Node backend proxies to it via `POST /api/v1/discovery-search`.

What the agent adds over the existing single-query Gemini search:

- **Semantic decomposition** — the LLM breaks one question into up to 3 distinct
  search queries (synonyms, data-source translation, broader category).
- **Parallel multi-search + round-robin dedup** — preserves relevance ranking.
- **`LookupContext` API** — fetches rich context for the merged entries (not used
  by the current Node search path).

## Endpoints

| Method | Path                | Body                              | Returns |
| ------ | ------------------- | --------------------------------- | ------- |
| GET    | `/health`           | —                                 | `{ status }` |
| POST   | `/discovery-search` | `{ "query": "...", "user_id"? }`  | `{ answer, results[], combined_context }` |

`results[]` items: `{ entry_name, system, resource_id, display_name }`.

## Prerequisites

A Google Cloud project with these APIs enabled:
- Knowledge Catalog (`dataplex.googleapis.com`)
- Vertex AI (`aiplatform.googleapis.com`)
- Service Usage (`serviceusage.googleapis.com`)

The runtime service account needs (at least):
- `roles/dataplex.viewer` (for `dataplex.projects.search` + `LookupContext`)
- `roles/aiplatform.user` (for `aiplatform.endpoints.predict`)
- `roles/serviceusage.serviceUsageConsumer`

## Environment variables

| Variable                   | Required | Notes |
| -------------------------- | -------- | ----- |
| `GOOGLE_CLOUD_PROJECT`     | yes      | Consumer / quota project. |
| `GOOGLE_GENAI_USE_VERTEXAI`| yes      | Set to `True` (the Dockerfile sets it). |
| `GEMINI_MODEL`             | no       | Override the default Gemini model if the pinned preview model isn't available in your project. |
| `PORT`                     | no       | Cloud Run sets this; defaults to 8080. |

## Run locally

```bash
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export GOOGLE_CLOUD_PROJECT=<your-project>
export GOOGLE_GENAI_USE_VERTEXAI=True
uvicorn main:app --reload --port 8080

curl -s localhost:8080/discovery-search \
  -H 'content-type: application/json' \
  -d '{"query":"tables about customer churn"}' | jq
```

Or run it the canonical ADK way (interactive): `adk run .` from the parent dir.

## Deploy to Cloud Run

```bash
gcloud run deploy kc-discovery-agent \
  --source agent_service \
  --region <region> \
  --no-allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=<project>,GOOGLE_GENAI_USE_VERTEXAI=True
```

Then point the Node backend at it:

```
DISCOVERY_AGENT_URL=https://kc-discovery-agent-xxxx-uc.a.run.app
```

Keep the service `--no-allow-unauthenticated` and give the BUI backend's service
account `roles/run.invoker` on it (the Node proxy fetches an ID token to call it).

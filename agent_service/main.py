"""FastAPI wrapper exposing the Knowledge Catalog Discovery Agent over HTTP.

This lets the (Node.js) Business User Interface backend call the Python ADK
agent as a microservice. Deploy this to Cloud Run and point the Node backend at
it via the DISCOVERY_AGENT_URL environment variable.

Endpoints:
  GET  /health           -> liveness probe
  POST /discovery-search -> run the agent on a natural-language query

POST body: { "query": "tables about customer churn", "user_id": "optional" }
Response:  {
  "answer": "<agent final text>",
  "results": [{ "entry_name", "system", "resource_id", "display_name" }, ...],
  "combined_context": "<rich LookupContext text>"
}
"""

import logging
import os

from fastapi import FastAPI
from pydantic import BaseModel

from google.adk.runners import InMemoryRunner
from google.genai import types as genai_types

from knowledge_catalog_discovery_agent.agent import discovery_agent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("discovery_agent_service")

APP_NAME = "knowledge_catalog_discovery_agent"

app = FastAPI(title="Knowledge Catalog Discovery Agent Service")

# A single in-process runner reused across requests.
runner = InMemoryRunner(agent=discovery_agent, app_name=APP_NAME)


class SearchRequest(BaseModel):
  query: str
  user_id: str | None = None


class SearchResponse(BaseModel):
  answer: str
  results: list[dict]
  combined_context: str


def _extract_tool_payload(event) -> dict | None:
  """Pulls the knowledge_catalog_multi_search response out of an ADK event."""
  content = getattr(event, "content", None)
  if not content or not getattr(content, "parts", None):
    return None
  for part in content.parts:
    func_response = getattr(part, "function_response", None)
    if func_response is None:
      continue
    name = getattr(func_response, "name", "")
    if name and "multi_search" not in name:
      continue
    response = getattr(func_response, "response", None)
    if isinstance(response, dict):
      return response
  return None


@app.get("/health")
def health() -> dict:
  return {"status": "ok"}


@app.post("/discovery-search", response_model=SearchResponse)
def discovery_search(req: SearchRequest) -> SearchResponse:
  user_id = req.user_id or "anonymous"

  # Each request gets its own session so turns don't bleed across users.
  session = runner.session_service.create_session_sync(
      app_name=APP_NAME, user_id=user_id
  )

  message = genai_types.Content(
      role="user", parts=[genai_types.Part(text=req.query)]
  )

  answer_parts: list[str] = []
  merged_results: list[dict] = []
  seen_names: set[str] = set()
  combined_context = ""

  for event in runner.run(
      user_id=user_id, session_id=session.id, new_message=message
  ):
    # Capture any tool output (the deduplicated entry list + rich context).
    payload = _extract_tool_payload(event)
    if payload:
      for item in payload.get("results", []) or []:
        name = item.get("entry_name")
        if name and name not in seen_names:
          seen_names.add(name)
          merged_results.append(item)
      if payload.get("combined_context"):
        combined_context = payload["combined_context"]

    # Capture the agent's final natural-language answer.
    if getattr(event, "is_final_response", None) and event.is_final_response():
      content = getattr(event, "content", None)
      if content and getattr(content, "parts", None):
        for part in content.parts:
          if getattr(part, "text", None):
            answer_parts.append(part.text)

  return SearchResponse(
      answer="".join(answer_parts).strip(),
      results=merged_results,
      combined_context=combined_context,
  )


if __name__ == "__main__":
  import uvicorn

  port = int(os.environ.get("PORT", "8080"))
  uvicorn.run(app, host="0.0.0.0", port=port)

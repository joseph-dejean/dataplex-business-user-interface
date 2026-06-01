"""Knowledge Catalog Discovery Agent.

Vendored from GoogleCloudPlatform/dataplex-labs. The model can be overridden
with the GEMINI_MODEL environment variable so the service keeps working as
model availability changes per project/region.
"""

import os

from google.adk.agents import llm_agent
from google.adk.models import google_llm

from . import tools
from .utils import get_consumer_project

consumer_project = get_consumer_project()

# The reference agent pins a preview model; allow an override via env so the
# service can be pointed at whatever Gemini model is enabled in the project.
GEMINI_MODEL = os.environ.get(
    "GEMINI_MODEL",
    f"projects/{consumer_project}/locations/global/publishers/google/models/gemini-3-flash-preview",
)

# Path to the skill file relative to the agent.py location.
SKILL_FILE_PATH = os.path.join(os.path.dirname(__file__), "SKILL.md")


def load_instruction() -> str:
  """Loads the agent instruction from the SKILL.md file."""
  with open(SKILL_FILE_PATH, "r") as f:
    return f.read()


discovery_agent = llm_agent.Agent(
    model=google_llm.Gemini(model=GEMINI_MODEL),
    name="knowledge_catalog_discovery_agent",
    description=(
        "Searches Knowledge Catalog for data entries based on Natural Language"
        " user queries."
    ),
    instruction=load_instruction(),
    tools=[
        tools.knowledge_catalog_multi_search,
    ],
)

# ADK CLI (`adk run`) looks for a `root_agent` symbol.
root_agent = discovery_agent

"""Agent Galaxy dashboard route: GET /api/plugins/agent-galaxy/graph, behind dashboard auth.

The graph itself comes from galaxy_graph.py (shared with export.py), loaded by path
because the dashboard imports this file outside any package.
"""
import asyncio
import importlib.util
import threading
import time
from pathlib import Path

from fastapi import APIRouter

from hermes_cli.config import get_hermes_home, load_config

_spec = importlib.util.spec_from_file_location("agent_galaxy_graph", Path(__file__).with_name("galaxy_graph.py"))
galaxy_graph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(galaxy_graph)

router = APIRouter()

CACHE_SECONDS = 120
_cache = {"at": 0.0, "graph": None}
_lock = threading.Lock()


def _agent_name():
    """`agent_galaxy.name` from config, else the profile's name, else "Hermes"."""
    configured = (load_config().get("agent_galaxy") or {}).get("name")
    if configured:
        return str(configured)
    home = get_hermes_home()
    return home.name if home.parent.name == "profiles" else "Hermes"


def _graph():
    with _lock:
        if _cache["graph"] is None or time.time() - _cache["at"] > CACHE_SECONDS:
            _cache["graph"], _cache["at"] = galaxy_graph.build(get_hermes_home(), _agent_name()), time.time()
        return _cache["graph"]


@router.get("/graph")
async def graph():
    return await asyncio.to_thread(_graph)

#!/usr/bin/env python3
"""Export an Agent Galaxy as a static site you can host anywhere.

    python3 export.py --hermes-home ~/.hermes --name my-agent --out galaxy-site

Writes index.html, index.js, three.core.min.js and graph.json to --out. Serve that
directory over HTTP (the page fetches graph.json, which file:// blocks).

The export is public by default: memory fact text and full project paths are left
out. Tool, skill, project, channel and memory-entity *names* and all counts are
included. --private keeps fact text and paths, for a page behind your own auth.
Standard library only; reads the Hermes databases read-only and never writes them.
"""
import argparse
import html
import json
import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "dashboard"))
import galaxy_graph  # noqa: E402  (after the path insert above)


def main():
    p = argparse.ArgumentParser(description="Export an Agent Galaxy as a static site.")
    p.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME", "~/.hermes"),
                   help="the agent's Hermes home (default: $HERMES_HOME or ~/.hermes)")
    p.add_argument("--name", default="Hermes", help="agent name shown at the galaxy's core")
    p.add_argument("--out", default="galaxy-site", help="output directory (default: galaxy-site)")
    p.add_argument("--private", action="store_true", help="also include memory fact text and full project paths")
    a = p.parse_args()

    home = Path(a.hermes_home).expanduser()
    if not (home / "state.db").exists():
        sys.exit(f"export.py: no state.db in {home}; point --hermes-home at a Hermes home")

    graph = galaxy_graph.build(home, a.name, public=not a.private)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "graph.json").write_text(json.dumps(graph), encoding="utf-8")
    for f in ("index.js", "three.core.min.js"):
        shutil.copy2(HERE / "dashboard" / "dist" / f, out / f)
    page = (HERE / "standalone" / "index.html").read_text(encoding="utf-8")
    (out / "index.html").write_text(page.replace("__AGENT_NAME__", html.escape(a.name)), encoding="utf-8")

    print(f"wrote {out}/ ({len(graph['nodes'])} stars, {len(graph['links'])} links, "
          f"{'PRIVATE: includes memory text and paths' if a.private else 'public: no memory text or paths'})")
    print(f"preview: python3 -m http.server -d {out} 8000")


if __name__ == "__main__":
    main()

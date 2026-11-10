"""Agent Galaxy graph builder: one read-only graph of a Hermes agent's tools, skills,
memory, projects and channels, built from its own state databases.

Standard library only, so the dashboard route (plugin_api.py) and the static-site
exporter (export.py) share it. Never writes: every database is opened mode=ro.
"""
import os
import re
import sqlite3
import time
from pathlib import Path

MAX_SKILLS = 40
MAX_TRANSITIONS = 150
MAX_PER_PROJECT = 6

# Session working directories that are not projects: nowhere, a bare home, or Hermes itself.
_NOT_PROJECT = re.compile(r"^(/|/root|/home/[^/]+|/Users/[^/]+|/opt/hermes(/.*)?|.*/\.hermes(/.*)?)?$")


def is_project(cwd):
    return bool(cwd) and not _NOT_PROJECT.match(cwd.rstrip("/") or "/")


def _ro(home, name):
    path = Path(home) / name
    if not path.exists():
        return None
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def build(home, name="Hermes", public=False, memory=True, min_facts=1, hide=()):
    """The graph for the Hermes home at *home*. *public* drops memory fact text and full
    project paths, for pages published outside the authenticated dashboard. *memory=False*
    leaves memory out entirely: entity names can name people and clients. *min_facts* skips
    memory entities with fewer facts (mostly noise). *hide* drops stars by name, any kind."""
    nodes, links = [], []

    def node(id_, label, group, count=0, born=None, **detail):  # born: first seen, unix seconds (None: always)
        nodes.append({"id": id_, "label": label, "group": group, "count": count, "born": born, "detail": detail})

    def link(a, b, kind, count=1):
        links.append({"source": a, "target": b, "kind": kind, "count": count})

    stats = {}
    project_by_name = {}
    state = _ro(home, "state.db")
    if state:
        with state:
            stats["sessions"] = state.execute("select count(*) from sessions").fetchone()[0]
            stats["messages"] = state.execute("select count(*) from messages").fetchone()[0]

            tools = state.execute(
                "select tool_name, count(*), min(timestamp) from messages where role='tool' and tool_name is not null "
                "group by 1 order by 2 desc").fetchall()
            stats["tool_calls"] = sum(c for _, c, _ in tools)
            node("hub:tools", "Tools", "hub", stats["tool_calls"])
            for tool, c, born in tools:
                node(f"tool:{tool}", tool, "tool", c, born)
                link("hub:tools", f"tool:{tool}", "member")

            # Which tool follows which, within a session: the agent's action flow.
            for prev, cur, c in state.execute(
                "with t as (select tool_name, lag(tool_name) over (partition by session_id order by id) prev "
                "from messages where role='tool' and tool_name is not null) "
                "select prev, tool_name, count(*) c from t where prev is not null and prev != tool_name "
                "group by 1, 2 order by c desc limit ?", (MAX_TRANSITIONS,)):
                link(f"tool:{prev}", f"tool:{cur}", "flow", c)

            skills = state.execute(
                "select json_extract(json_extract(j.value, '$.function.arguments'), '$.name'), count(*), min(m.timestamp) "
                "from messages m, json_each(m.tool_calls) j "
                "where m.role='assistant' and m.tool_calls like '%skill_view%' "
                "and json_extract(j.value, '$.function.name') = 'skill_view' "
                "group by 1 order by 2 desc limit ?", (MAX_SKILLS,)).fetchall()
            node("hub:skills", "Skills", "hub", sum(c for _, c, _ in skills))
            for skill, c, born in skills:
                if skill:
                    node(f"skill:{skill}", skill, "skill", c, born)
                    link("hub:skills", f"skill:{skill}", "member")

            projects = [row for row in state.execute(
                "select cwd, count(*), coalesce(sum(tool_call_count), 0), min(started_at) from sessions "
                "group by 1 order by 2 desc") if is_project(row[0])]
            node("hub:projects", "Projects", "hub", sum(row[1] for row in projects))
            for cwd, c, tc, born in projects:
                node(f"project:{cwd}", os.path.basename(cwd), "project", c, born, tool_calls=tc, **({} if public else {"path": cwd}))
                link("hub:projects", f"project:{cwd}", "member")
                project_by_name[os.path.basename(cwd).lower()] = f"project:{cwd}"

            # Cross links, only where the sessions show a real relationship.
            def top_per_project(rows, prefix, kind):
                seen = {}
                for cwd, target, c in rows:  # rows arrive ordered by count, descending
                    if target and seen.setdefault(cwd, 0) < MAX_PER_PROJECT:
                        seen[cwd] += 1
                        link(f"project:{cwd}", f"{prefix}:{target}", kind, c)

            top_per_project(state.execute(
                "select s.cwd, m.tool_name, count(*) from messages m join sessions s on s.id = m.session_id "
                "where m.role='tool' and m.tool_name is not null and s.cwd != '' "
                "group by 1, 2 order by 3 desc"), "tool", "uses-tool")
            top_per_project(state.execute(
                "select s.cwd, json_extract(json_extract(j.value, '$.function.arguments'), '$.name'), count(*) "
                "from messages m join sessions s on s.id = m.session_id, json_each(m.tool_calls) j "
                "where m.role='assistant' and m.tool_calls like '%skill_view%' and s.cwd != '' "
                "and json_extract(j.value, '$.function.name') = 'skill_view' "
                "group by 1, 2 order by 3 desc"), "skill", "uses-skill")

            channels = state.execute(
                "select source, count(*), min(started_at) from sessions group by 1 order by 2 desc").fetchall()
            node("hub:channels", "Channels", "hub", sum(c for _, c, _ in channels))
            for src, c, born in channels:
                node(f"channel:{src}", src, "channel", c, born)
                link("hub:channels", f"channel:{src}", "member")
            for src, cwd, c in state.execute(
                "select source, cwd, count(*) from sessions where cwd != '' group by 1, 2"):
                link(f"channel:{src}", f"project:{cwd}", "runs-in", c)
        state.close()

    mem = _ro(home, "memory_store.db") if memory else None
    if mem:
        with mem:
            stats["facts"] = mem.execute("select count(*) from facts").fetchone()[0]
            node("hub:memory", "Memory", "hub", stats["facts"])
            facts_by_entity = {}
            for eid, content in mem.execute(
                "select fe.entity_id, f.content from fact_entities fe join facts f using (fact_id) "
                "order by f.trust_score desc"):
                facts_by_entity.setdefault(eid, []).append(content[:200])
            for eid, label, etype, born in mem.execute(
                    "select entity_id, name, entity_type, cast(strftime('%s', created_at) as real) from entities"):
                facts = facts_by_entity.get(eid, [])
                if len(facts) < min_facts:
                    continue
                node(f"entity:{eid}", label if len(label) <= 48 else label[:47] + "…", "memory", len(facts), born, type=etype, **({} if public else {"facts": facts[:5]}))
                link("hub:memory", f"entity:{eid}", "member")
                for word in set(re.findall(r"[\w-]+", label.lower())) & project_by_name.keys():
                    link(f"entity:{eid}", project_by_name[word], "about", len(facts))  # names a project
            # Entities that share a fact are linked: the shape of what it remembers.
            for a, b, c in mem.execute(
                "select x.entity_id, y.entity_id, count(*) from fact_entities x "
                "join fact_entities y on x.fact_id = y.fact_id and x.entity_id < y.entity_id group by 1, 2"):
                link(f"entity:{a}", f"entity:{b}", "shared-fact", c)
        mem.close()

    hidden = {h.strip().lower() for h in hide if h.strip()}
    nodes = [n for n in nodes if n["group"] == "hub" or n["label"].lower() not in hidden]
    node("agent", name, "agent", stats.get("sessions", 0), **stats)
    for n in nodes:
        if n["group"] == "hub":
            link("agent", n["id"], "hub", n["count"])
    if public:  # project ids are full paths; key them by folder name instead
        rename = {}
        for n in nodes:
            if n["group"] == "project":
                new = f"project:{n['label']}"
                while new in rename.values():
                    new += "-2"
                rename[n["id"]] = n["id"] = new
        for l in links:
            l["source"], l["target"] = rename.get(l["source"], l["source"]), rename.get(l["target"], l["target"])
    ids = {n["id"] for n in nodes}
    links = [l for l in links if l["source"] in ids and l["target"] in ids]  # e.g. a skill outside the top 40
    return {"nodes": nodes, "links": links, "stats": stats, "built_at": time.time()}


if __name__ == "__main__":  # self-check: python3 dashboard/galaxy_graph.py
    for cwd in ("/workspace/app", "/home/me/code/app", "/Users/me/dev/app", "/srv/app"):
        assert is_project(cwd), cwd
    for cwd in ("", None, "/", "/root", "/home/me", "/home/me/", "/Users/me", "/opt/hermes", "/opt/hermes/x",
                "/home/me/.hermes", "/home/me/.hermes/profiles/a"):
        assert not is_project(cwd), cwd
    import tempfile
    with tempfile.TemporaryDirectory() as d:  # a tiny memory store: one rich entity, one noisy, one hidden
        db = sqlite3.connect(Path(d) / "memory_store.db")
        db.executescript(
            "create table facts(fact_id, content, trust_score); create table entities(entity_id, name, entity_type, created_at);"
            "create table fact_entities(fact_id, entity_id);"
            "insert into facts values (1,'a',1),(2,'b',1),(3,'c',1);"
            "insert into entities values (1,'Rich','x','2026-11-01 00:00:00'),(2,'Say hi','x',null),(3,'Secret','x',null);"
            "insert into fact_entities values (1,1),(2,1),(3,2),(1,3),(2,3);")
        db.commit(); db.close()
        label = lambda g: {n["label"] for n in g["nodes"] if n["group"] == "memory"}
        assert label(build(d)) == {"Rich", "Say hi", "Secret"}
        assert label(build(d, min_facts=2)) == {"Rich", "Secret"}
        g = build(d, min_facts=2, hide=["secret"])
        assert label(g) == {"Rich"} and all("entity:3" not in (l["source"], l["target"]) for l in g["links"])
        assert not label(build(d, memory=False))
        assert {n["label"]: n["born"] for n in build(d)["nodes"]}["Rich"] == 1793491200  # 2026-11-01 UTC
        sdb = sqlite3.connect(Path(d) / "state.db")  # one session in a project folder
        sdb.executescript(
            "create table sessions(id, source, cwd, started_at, tool_call_count);"
            "create table messages(id, session_id, role, tool_name, tool_calls, timestamp);"
            "insert into sessions values ('s','cli','/home/me/code/app',1,2);"
            "insert into messages values (1,'s','tool','read',null,5),(2,'s','tool','write',null,9);")
        sdb.commit(); sdb.close()
        g = build(d, public=True)
        assert not any("/" in str(v) for n in g["nodes"] for v in (n["id"], *n["detail"].values())), "path leaked"
        assert not any("/" in l["source"] + l["target"] for l in g["links"]), "path leaked in a link"
        assert {n["id"]: n["born"] for n in g["nodes"]}["tool:write"] == 9
    print("galaxy_graph: ok")

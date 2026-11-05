// Agent Galaxy: 3D force graph of /api/plugins/agent-galaxy/graph (or an exported graph.json), drawn as a galaxy.
// 3d-force-graph is pinned by version and Subresource Integrity, never bundled.
// three.core.min.js is three r186 (the revision 3d-force-graph bundles), vendored
// beside this file so the glow, disk and starfield objects need no other CDN.
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const { React } = SDK;
  const { useState, useEffect, useRef } = SDK.hooks;
  const h = React.createElement;

  const LIB_URL = "https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/dist/3d-force-graph.min.js";
  const LIB_SRI = "sha384-i98VDQKdpyVrtyuFn0fjUWJBLBmxnqHqOANcvYe9HLJUgT2wPixa4ZkLd7Dh3VEk";
  // Beside this script, so the same file works in the dashboard and on an exported static site.
  const THREE_URL = new URL("three.core.min.js", document.currentScript.src).href;

  const COLORS = {
    agent: "#fff1d0",
    hub: "#ffd166",
    tool: "#4cc9f0",
    skill: "#b388ff",
    memory: "#06d6a0",
    project: "#ff8fab",
    channel: "#f4a261",
  };
  // Drawn link kinds (hub/member links only shape the layout), and how the panel words them.
  const LINK_COLORS = {
    flow: "#7fdbff", "uses-tool": "#ff8fab", "uses-skill": "#d4a5ff",
    "runs-in": "#f4a261", "shared-fact": "#06d6a0", about: "#06d6a0",
  };
  const LINK_VERBS = {
    flow: "then", "uses-tool": "uses", "uses-skill": "loads",
    "runs-in": "runs in", "shared-fact": "shares a fact", about: "about",
  };
  const ANIMATED = new Set(["flow", "uses-tool", "uses-skill", "runs-in"]);
  const DISK_R = 300; // spiral disk is built at this radius, then scaled to the layout

  let libPromise = null;
  function loadLib() {
    libPromise = libPromise || Promise.all([
      window.ForceGraph3D ? window.ForceGraph3D : new Promise(function (resolve, reject) {
        const s = document.createElement("script");
        s.src = LIB_URL;
        s.integrity = LIB_SRI;
        s.crossOrigin = "anonymous";
        s.onload = function () { resolve(window.ForceGraph3D); };
        s.onerror = function () { reject(new Error("could not load 3d-force-graph")); };
        document.head.appendChild(s);
      }),
      import(THREE_URL),
    ]).catch(function (e) { libPromise = null; throw e; });
    return libPromise;
  }

  // ---- space scenery -------------------------------------------------------

  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

  function glowTexture(THREE) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.12, "rgba(255,255,255,0.9)");
    g.addColorStop(0.35, "rgba(255,255,255,0.28)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function glow(THREE, tex, color, size, opacity) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: color, opacity: opacity == null ? 1 : opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    s.scale.set(size, size, 1);
    return s;
  }

  function label(THREE, text, color) {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    const font = "600 44px system-ui, sans-serif";
    ctx.font = font;
    c.width = Math.ceil(ctx.measureText(text).width) + 24;
    c.height = 64;
    ctx.font = font;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 12, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
    s.scale.set(c.width / 4, c.height / 4, 1);
    s.raycast = function () {}; // labels never steal clicks
    return s;
  }

  function points(THREE, tex, positions, colors, size, opacity, attenuate) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const p = new THREE.Points(geo, new THREE.PointsMaterial({
      size: size, map: tex, vertexColors: true, opacity: opacity, sizeAttenuation: attenuate,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    p.raycast = function () {};
    return p;
  }

  // Galaxy types: stardust in the XZ plane (Y is the galaxy's axis), built at radius DISK_R.
  // `flat` is how hard the star layout is squashed onto that plane (0 = free 3D).
  const SHAPES = {
    elliptical: { label: "Elliptical", flat: 0 },
    spiral: { label: "Spiral", flat: 0.25 },
    barred: { label: "Barred spiral", flat: 0.25 },
    ring: { label: "Ring", flat: 0.25 },
    irregular: { label: "Irregular", flat: 0.08 },
  };

  function galaxyDust(THREE, tex, shape) {
    const pos = [], col = [];
    const C = (x) => new THREE.Color(x);
    const core = C("#ffe2b0"), mid = C("#b388ff"), rim = C("#4cc9f0"), c = new THREE.Color();
    const R = DISK_R;
    const add = (x, y, z, color) => { pos.push(x, y, z); color.toArray(col, col.length); };
    const disk = (t) => t < 0.5 ? c.lerpColors(core, mid, t * 2) : c.lerpColors(mid, rim, t * 2 - 1);
    const bulge = (n, size) => {
      for (let i = 0; i < n; i++) {
        const r = Math.abs(gauss()) * R * size, a = Math.random() * 2 * Math.PI;
        add(Math.cos(a) * r, gauss() * R * size * 0.4, Math.sin(a) * r, core);
      }
    };
    const arms = (n, count, r0, twist) => {
      for (let i = 0; i < count; i++) {
        const t = Math.pow(Math.random(), 0.7), r = r0 + t * (R - r0);
        const a = (i % n) * 2 * Math.PI / n + t * twist + gauss() * (0.5 - 0.3 * t);
        add(Math.cos(a) * r + gauss() * 8, gauss() * 14 * (1 - 0.7 * t), Math.sin(a) * r + gauss() * 8, disk(r / R));
      }
    };

    if (shape === "barred") {
      for (let i = 0; i < 2500; i++) {
        const x = (Math.random() * 2 - 1) * R * 0.32;
        add(x, gauss() * 8, gauss() * R * 0.05, disk(Math.abs(x) / R));
      }
      arms(2, 7000, R * 0.32, 3.4);
      bulge(1500, 0.12);
    } else if (shape === "elliptical") {
      const old = C("#ffb36b");
      for (let i = 0; i < 11000; i++) {
        const x = gauss() * R * 0.75, y = gauss() * R * 0.5, z = gauss() * R * 0.62;
        add(x, y, z, c.lerpColors(core, old, Math.min(1, Math.hypot(x, y, z) / (R * 0.7))));
      }
    } else if (shape === "ring") {
      for (let i = 0; i < 7000; i++) {
        const r = R * (0.85 + gauss() * 0.07), a = Math.random() * 2 * Math.PI;
        add(Math.cos(a) * r, gauss() * 10, Math.sin(a) * r, i % 4 ? rim : mid);
      }
      bulge(3000, 0.2);
    } else if (shape === "irregular") {
      const tints = [core, mid, rim, C("#ff8fab"), C("#06d6a0")];
      for (let k = 0; k < 8; k++) {
        const cx = gauss() * R * 0.7, cz = gauss() * R * 0.7, cy = gauss() * R * 0.15, spread = R * (0.08 + Math.random() * 0.12);
        for (let i = 0; i < 1300; i++) add(cx + gauss() * spread, cy + gauss() * spread * 0.6, cz + gauss() * spread, tints[k % tints.length]);
      }
    } else {
      arms(3, 9000, 0, 4.2);
      bulge(2500, 0.18);
    }
    return points(THREE, tex, pos, col, 5, 0.8, true);
  }

  function skybox(THREE, tex) {
    const sky = new THREE.Group();
    const tints = ["#ffffff", "#ffffff", "#ffffff", "#cfe3ff", "#ffe0c2", "#d9ccff"].map((x) => new THREE.Color(x));
    function shell(n) {
      const pos = [], col = [];
      for (let i = 0; i < n; i++) {
        const u = Math.random() * 2 - 1, a = Math.random() * 2 * Math.PI, r = 3000 + Math.random() * 2000;
        const k = Math.sqrt(1 - u * u);
        pos.push(r * k * Math.cos(a), r * u, r * k * Math.sin(a));
        tints[i % tints.length].toArray(col, col.length);
      }
      return { pos, col };
    }
    const dim = shell(5000), bright = shell(350);
    sky.add(points(THREE, tex, dim.pos, dim.col, 2.2, 0.7, false));
    sky.add(points(THREE, tex, bright.pos, bright.col, 5, 0.95, false));
    ["#6a3fd1", "#1f6feb", "#c2185b", "#00897b", "#5e35b1", "#283593"].forEach(function (color, i) {
      const a = i * 1.1 + 0.4, y = (i % 3 - 1) * 1400;
      const n = glow(THREE, tex, color, 2200 + (i % 3) * 700, 0.13);
      n.position.set(Math.cos(a) * 3800, y, Math.sin(a) * 3800);
      n.raycast = function () {};
      sky.add(n);
    });
    return sky;
  }

  // Squash the layout toward the disk plane so it reads as a galaxy, not a ball.
  // `force.k` is the current galaxy type's flatness.
  function flattenForce(k) {
    let nodes = [];
    function force(alpha) {
      for (const n of nodes) if (n.group !== "agent") n.vy -= (n.y || 0) * force.k * alpha;
    }
    force.k = k;
    force.initialize = function (ns) { nodes = ns; };
    return force;
  }

  // Saved only when the viewer picks a type, so a later default change still reaches everyone else.
  const SHAPE_KEY = "agent-galaxy-type";
  const DEFAULT_SHAPE = "elliptical";
  function savedShape() {
    try { const v = localStorage.getItem(SHAPE_KEY); return v in SHAPES ? v : DEFAULT_SHAPE; } catch (e) { return DEFAULT_SHAPE; }
  }

  // ---- component -----------------------------------------------------------

  // Only action flow and shared-memory links are drawn; hub/member links just shape the layout.
  const nodeShown = (hid) => (n) => !hid[n.group];
  const linkShown = (hid) => (l) => l.kind in LINK_COLORS
    && !hid[l.source.group] && !hid[l.target.group];

  const fmt = (n) => Number(n || 0).toLocaleString();
  // 3d-force-graph puts string tooltips in with innerHTML; labels come from transcripts and memory.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

  function Detail({ node }) {
    if (!node) {
      return h("p", { className: "text-xs text-muted-foreground" },
        "Click a star to inspect it. Drag to orbit, scroll to zoom.");
    }
    const d = node.detail || {};
    const rows = node.group === "agent" ? [] : [h("div", { key: "c" }, "count: ", h("b", null, fmt(node.count)))];
    if (node.group === "agent") {
      ["sessions", "messages", "tool_calls", "facts"].forEach(function (k) {
        rows.push(h("div", { key: k }, k.replace("_", " "), ": ", h("b", null, fmt(d[k]))));
      });
    }
    if (d.path) rows.push(h("div", { key: "p" }, d.path));
    if (node.group === "project") rows.push(h("div", { key: "t" }, "tool calls: ", h("b", null, fmt(d.tool_calls))));
    if (d.type) rows.push(h("div", { key: "ty" }, "type: ", d.type));
    (node.connections || []).forEach(function (f, i) {
      rows.push(h("div", { key: "f" + i, className: "text-muted-foreground" }, f));
    });
    (Array.isArray(d.facts) ? d.facts : []).forEach(function (f, i) {
      rows.push(h("li", { key: "m" + i, className: "text-muted-foreground" }, f));
    });
    return h("div", { className: "text-xs space-y-1" },
      h("div", { className: "text-sm font-semibold", style: { color: COLORS[node.group] } },
        node.label, " ", h("span", { className: "text-muted-foreground font-normal" }, node.group)),
      rows);
  }

  function Galaxy() {
    const el = useRef(null);
    const fg = useRef(null);
    const hiddenRef = useRef({});
    const space = useRef(null); // { THREE, tex, dust, flatten } once the scene exists
    const [shape, setShape] = useState(savedShape);
    const shapeRef = useRef(shape);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null);
    const [hidden, setHidden] = useState({});

    useEffect(function () {
      SDK.fetchJSON("/api/plugins/agent-galaxy/graph").then(setData).catch(function (e) { setError(String(e)); });
    }, []);

    useEffect(function () {
      if (!data || !el.current) return;
      let disposed = false, resumeTimer = null;
      loadLib().then(function ([ForceGraph3D, THREE]) {
        if (disposed) return;
        // Strongest drawn connections per star, for the detail panel.
        const name = Object.fromEntries(data.nodes.map((n) => [n.id, n.label]));
        data.nodes.forEach(function (n) {
          if (n.group === "agent") n.fx = n.fy = n.fz = 0; // the galactic core stays put
          n.connections = data.links.filter((l) => l.kind in LINK_COLORS && (l.source === n.id || l.target === n.id))
            .sort((a, b) => b.count - a.count).slice(0, 10)
            .map((l) => (l.source === n.id ? "→ " + name[l.target] : "← " + name[l.source])
              + " · " + LINK_VERBS[l.kind] + " ×" + fmt(l.count));
        });
        const maxByKind = {}, degree = {};
        const structural = (l) => l.kind === "flow" || l.kind === "hub" || l.kind === "member" || l.kind === "shared-fact";
        data.links.forEach(function (l) {
          maxByKind[l.kind] = Math.max(maxByKind[l.kind] || 1, l.count);
          if (!structural(l)) return;
          degree[l.source] = (degree[l.source] || 0) + 1;
          degree[l.target] = (degree[l.target] || 0) + 1;
        });
        const tex = glowTexture(THREE);
        const dust = galaxyDust(THREE, tex, shapeRef.current);
        const flatten = flattenForce(SHAPES[shapeRef.current].flat);
        space.current = { THREE: THREE, tex: tex, dust: dust, flatten: flatten };

        const g = ForceGraph3D({ controlType: "orbit" })(el.current)
          .backgroundColor("#000004")
          .showNavInfo(false)
          .width(el.current.clientWidth)
          .height(el.current.clientHeight)
          .warmupTicks(120)
          // Node drag off: its drag-end fakes a touch pointerup that crashes OrbitControls, and
          // stars are not meant to be moved anyway.
          .enableNodeDrag(false)
          .nodeLabel((n) => esc(n.label) + " · " + fmt(n.count))
          .nodeThreeObject(function (n) {
            const color = COLORS[n.group] || "#999";
            if (n.group === "agent") {
              const o = new THREE.Group();
              o.add(glow(THREE, tex, "#ffffff", 46));
              const halo = glow(THREE, tex, "#ffc46b", 190, 0.45);
              halo.raycast = function () {};
              o.add(halo);
              const l = label(THREE, n.label, "#ffc46b");
              l.position.y = 40;
              o.add(l);
              return o;
            }
            const size = n.group === "hub" ? 30 : 9 + Math.log10(1 + n.count) * 5;
            const star = glow(THREE, tex, color, size);
            if (n.group !== "hub") return star;
            const o = new THREE.Group();
            o.add(star);
            const l = label(THREE, n.label, color);
            l.position.y = 24;
            o.add(l);
            return o;
          })
          .nodeVisibility(nodeShown(hiddenRef.current))
          .linkVisibility(linkShown(hiddenRef.current))
          .linkColor((l) => LINK_COLORS[l.kind])
          .linkOpacity(0.12)
          .linkWidth(0)
          .linkCurvature(0.25)
          .linkDirectionalParticles((l) => ANIMATED.has(l.kind) ? 1 + Math.round(3 * l.count / maxByKind[l.kind]) : 0)
          .linkDirectionalParticleColor((l) => LINK_COLORS[l.kind])
          .linkDirectionalParticleSpeed(0.005)
          .linkDirectionalParticleWidth(1.6)
          .onNodeClick(function (n) {
            setSelected(n);
            g.controls().autoRotate = false;
            const d = Math.hypot(n.x || 0, n.y || 0, n.z || 0);
            const r = d < 1 ? 0 : 1 + 110 / d;
            g.cameraPosition(d < 1 ? { x: 0, y: 160, z: 320 } : { x: n.x * r, y: n.y * r + 50, z: n.z * r }, n, 1200);
          })
          .onEngineStop(function () {
            let maxR = 1;
            g.graphData().nodes.forEach(function (n) { maxR = Math.max(maxR, Math.hypot(n.x || 0, n.z || 0)); });
            space.current.dust.scale.setScalar(maxR * 1.15 / DISK_R);
          })
          .graphData(data);

        // Cross-cluster links pull only gently, so each constellation keeps its shape.
        g.d3Force("link")
          .distance((l) => l.kind === "hub" ? 80 : l.kind === "member" ? 38 : 70)
          .strength((l) => structural(l) ? 1 / Math.min(degree[l.source.id], degree[l.target.id]) : 0.005);
        // Short-range repulsion only: stars inside a system keep apart, systems don't push each other away.
        g.d3Force("charge").strength(-30).distanceMax(150);
        g.d3Force("flatten", flatten);
        g.scene().add(dust);
        g.scene().add(skybox(THREE, tex));

        const cam = g.camera();
        cam.far = 20000;
        cam.updateProjectionMatrix();
        const back = el.current.clientWidth < 600 ? 1.9 : 1; // narrow screens need more distance
        g.cameraPosition({ x: 0, y: 170 * back, z: 350 * back }, { x: 0, y: 0, z: 0 });

        const controls = g.controls();
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.35;
        controls.maxDistance = 2200;
        controls.addEventListener("start", function () { clearTimeout(resumeTimer); controls.autoRotate = false; });
        controls.addEventListener("end", function () {
          clearTimeout(resumeTimer);
          resumeTimer = setTimeout(function () { controls.autoRotate = true; }, 8000);
        });
        fg.current = g;
      }).catch(function (e) { setError(String(e)); });
      const onResize = function () {
        if (fg.current && el.current) fg.current.width(el.current.clientWidth).height(el.current.clientHeight);
      };
      window.addEventListener("resize", onResize);
      return function () {
        disposed = true;
        clearTimeout(resumeTimer);
        window.removeEventListener("resize", onResize);
        if (fg.current) { fg.current._destructor(); fg.current = null; }
        space.current = null;
      };
    }, [data]);

    // Switching type swaps the stardust and lets the stars resettle into the new form.
    useEffect(function () {
      shapeRef.current = shape;
      const g = fg.current, sp = space.current;
      if (!g || !sp) return;
      const old = sp.dust;
      sp.dust = galaxyDust(sp.THREE, sp.tex, shape);
      sp.dust.scale.copy(old.scale);
      g.scene().remove(old);
      old.geometry.dispose();
      old.material.dispose();
      g.scene().add(sp.dust);
      sp.flatten.k = SHAPES[shape].flat;
      g.d3ReheatSimulation();
    }, [shape]);

    useEffect(function () {
      hiddenRef.current = hidden;
      const g = fg.current;
      if (g) g.nodeVisibility(nodeShown(hidden)).linkVisibility(linkShown(hidden));
    }, [hidden]);

    const s = (data && data.stats) || {};
    const agentName = ((data && data.nodes.find((n) => n.group === "agent")) || {}).label || "";
    return h("div", { className: "space-y-2" },
      h("div", { className: "flex flex-wrap items-center gap-3 text-xs" },
        h("span", { className: "font-semibold text-sm" }, agentName),
        ["sessions", "messages", "tool_calls", "facts"].map((k) =>
          h("span", { key: k, className: "text-muted-foreground" }, k.replace("_", " "), " ", h("b", null, fmt(s[k])))),
        h("span", { className: "flex-1" }),
        h("select", {
          value: shape, "aria-label": "Galaxy type",
          onChange: function (e) {
            setShape(e.target.value);
            try { localStorage.setItem(SHAPE_KEY, e.target.value); } catch (err) { /* per-viewer nicety only */ }
          },
          className: "bg-transparent border border-border rounded px-1 py-0.5 text-xs",
        }, Object.keys(SHAPES).map((k) => h("option", { key: k, value: k, style: { color: "#000" } }, SHAPES[k].label))),
        Object.keys(COLORS).filter((g) => g !== "agent").map((g) =>
          h("label", { key: g, className: "flex items-center gap-1 cursor-pointer" },
            h("input", { type: "checkbox", checked: !hidden[g],
              onChange: () => setHidden(Object.assign({}, hidden, { [g]: !hidden[g] })) }),
            h("span", { style: { color: COLORS[g] } }, "●"), g))),
      error && h("p", { className: "text-xs text-destructive" }, error),
      !data && !error && h("p", { className: "text-xs text-muted-foreground" }, "Mapping the galaxy…"),
      h("div", { style: { position: "relative" } },
        h("div", { ref: el, style: { height: "calc(100vh - var(--galaxy-chrome, 190px))", minHeight: 420, borderRadius: 8, overflow: "hidden" } }),
        h("div", {
          style: { position: "absolute", top: 12, right: 12, width: "min(300px, 60%)", maxHeight: "70%", overflowY: "auto",
            background: "rgba(5,6,15,0.82)", color: "#e6e6f0", padding: 12, borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.12)" },
        }, h(Detail, { node: selected }))));
  }

  window.__HERMES_PLUGINS__.register("agent-galaxy", Galaxy);
})();

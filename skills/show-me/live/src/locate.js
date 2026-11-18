(() => {
  let current = null;
  let saved = null;

  const clear = () => {
    if (!current) return;
    current.style.outline = saved[0];
    current.style.outlineOffset = saved[1];
    current = null;
  };

  const coreText = (t) => {
    if (!t) return "";
    const s = String(t).replace(/\[(before|after): "[^"]*"\]/g, " ").replace(/\s+/g, " ").trim();
    if (s) return s;
    const m = String(t).match(/\[(?:before|after): "([^"]*)"\]/);
    return m ? m[1].trim() : "";
  };

  const pattern = (t) => {
    const words = coreText(t).replace(/(\.\.\.|…)$/, "").split(" ").filter(Boolean).slice(0, 10);
    if (!words.length) return null;
    return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "i");
  };

  const pageTop = (e) => e.getBoundingClientRect().top + scrollY;
  const nearest = (els, y) => (typeof y === "number" ? els.slice().sort((a, b) => Math.abs(pageTop(a) - y) - Math.abs(pageTop(b) - y)) : els)[0];
  const rendered = (e) => e.getClientRects().length > 0;

  const textIndex = () => {
    const nodes = [];
    let text = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT|TEMPLATE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) { nodes.push([text.length, n]); text += n.data; }
    return { text, nodes };
  };

  const nodeAt = (nodes, i) => {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid][0] <= i) lo = mid; else hi = mid - 1; }
    return nodes[lo][1];
  };

  const byText = (re, y) => {
    if (!re) return null;
    const { text, nodes } = textIndex();
    if (!nodes.length) return null;
    const g = new RegExp(re.source, "gi");
    const hits = [];
    let m;
    while ((m = g.exec(text)) && hits.length < 50) {
      const a = nodeAt(nodes, m.index);
      const b = nodeAt(nodes, m.index + Math.max(m[0].length - 1, 0));
      let e = a.parentElement;
      while (e && !e.contains(b)) e = e.parentElement;
      if (e) hits.push(e);
      if (!m[0].length) g.lastIndex++;
    }
    const visible = hits.filter(rendered);
    return nearest(visible.length ? visible : hits, y) || null;
  };

  const scrollToY = (y) => { if (typeof y === "number") scrollTo(0, Math.max(0, y - innerHeight / 3)); };

  const show = (e, y) => {
    for (let p = e; p; p = p.parentElement) if (p.tagName === "DETAILS" && !p.open) p.open = true;
    if (e === document.body || e === document.documentElement) { scrollToY(y); return; }
    current = e;
    saved = [e.style.outline, e.style.outlineOffset];
    e.style.outline = "2px solid #7c3aed";
    e.style.outlineOffset = "2px";
    e.scrollIntoView({ block: "center" });
  };

  const locate = (d) => {
    clear();
    const re = pattern(d.selectedText) || pattern(d.nearbyText);
    const y = typeof d.y === "number" ? d.y : undefined;
    let cands = [];
    try { if (d.elementPath) cands = [...document.querySelectorAll(d.elementPath)]; } catch {}
    if (cands.length && re) {
      const withText = cands.filter((e) => re.test(e.textContent || ""));
      if (withText.length) { show(nearest(withText, y), y); return { found: true, how: "selector", textMatch: true }; }
    }
    if (cands.length && !re) { show(nearest(cands, y), y); return { found: true, how: "selector", textMatch: null }; }
    const t = byText(re, y);
    if (t) { show(t, y); return { found: true, how: "text", textMatch: true }; }
    if (cands.length) { show(nearest(cands, y), y); return { found: true, how: "selector", textMatch: false }; }
    scrollToY(y);
    return { found: false, how: "position", textMatch: false };
  };

  addEventListener("message", (ev) => {
    const d = ev.data || {};
    if (d.type === "clear") clear();
    if (d.type !== "locate") return;
    let r;
    try { r = locate(d); } catch (e) { r = { found: false, how: "position", error: String(e) }; }
    (ev.source || parent).postMessage({ type: "located", id: d.id, ...r }, "*");
  });
})();

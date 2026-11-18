import React from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";

const cfg = window.__SHOW_ME_LIVE__ || {};
const endpoint = !("endpoint" in cfg)
  ? "http://localhost:4747"
  : cfg.endpoint && cfg.endpoint.startsWith("/") ? location.origin + cfg.endpoint : cfg.endpoint || undefined;
const printStyle = document.createElement("style");
printStyle.textContent = "@media print{agentation-toolbar,[data-agentation-portal]{display:none!important}}";
document.head.appendChild(printStyle);
const host = document.createElement("div");
host.id = "show-me-live-toolbar";
document.body.appendChild(host);
createRoot(host).render(
  <Agentation
    endpoint={endpoint}
    sessionId={cfg.sessionId}
    appName={`show-me: ${cfg.file || document.title}`}
    identifyingAttributes={["data-iteration", "data-kind", "data-node", "id"]}
    copyToClipboard={cfg.copyToClipboard ?? false}
  />
);

if (cfg.reload) {
  const es = new EventSource(cfg.reload);
  es.addEventListener("change", () => location.reload());
}

function HistoryPill({ href }) {
  const [info, setInfo] = React.useState(null);
  React.useEffect(() => {
    const rel = new URL(href, location.origin).searchParams.get("path");
    fetch(`/__live/api/history?path=${encodeURIComponent(rel)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => h && setInfo({ latest: h.latest, pending: h.comments.filter((c) => c.status === "pending").length }))
      .catch(() => {});
  }, [href]);
  const label = info ? `History · v${info.latest} · ${info.pending} pending` : "History";
  return (
    <a
      className="sml-history-pill"
      href={href}
      target="_blank"
      rel="noopener"
      title="Open version history and comment review"
      style={{
        position: "fixed", left: 16, bottom: 16, zIndex: 2147483000, font: "12px/1 -apple-system,system-ui,sans-serif",
        background: "#f3f0ff", border: "1px solid #c9bdf5", color: "#2b2350", borderRadius: 999, padding: "7px 12px",
        textDecoration: "none", boxShadow: "0 1px 4px rgba(43,35,80,.15)",
      }}
    >
      {label}
    </a>
  );
}

if (cfg.history) {
  printStyle.textContent += "@media print{.sml-history-pill{display:none!important}}";
  const pillHost = document.createElement("div");
  pillHost.id = "show-me-live-history";
  document.body.appendChild(pillHost);
  createRoot(pillHost).render(<HistoryPill href={cfg.history} />);
}

import http from "node:http";
import { SessionManager } from "./session.js";
import { listAllSessions } from "./db.js";

const PORT = Number(process.env.DASHBOARD_PORT ?? 3000);

function getSessionsData() {
  const dbRows = listAllSessions();
  return dbRows.map((row) => {
    const live = SessionManager.get(row.thread_id);
    return {
      threadId: row.thread_id,
      sessionId: row.session_id,
      channelId: row.channel_id,
      mode: row.mode,
      trigger: row.trigger,
      workDir: row.work_dir,
      createdAt: row.created_at,
      lastActive: row.last_active,
      state: live?.state ?? "dormant",
      queueDepth: live?.messageQueue.length ?? 0,
    };
  });
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kimi Discord Bridge — Sessions</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 2rem; }
  h1 { margin: 0 0 1rem; font-size: 1.5rem; }
  .stats { display: flex; gap: 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; color: #94a3b8; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 0.6rem 0.75rem; text-align: left; border-bottom: 1px solid #1e293b; }
  th { color: #94a3b8; font-weight: 500; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
  tr:hover td { background: #1e293b; }
  .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
  .badge-dormant { background: #475569; color: #f1f5f9; }
  .badge-active { background: #22c55e; color: #064e3b; }
  .badge-busy { background: #f59e0b; color: #78350f; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
  .empty { color: #64748b; margin-top: 2rem; }
</style>
</head>
<body>
<h1>🤖 Kimi Discord Bridge Sessions</h1>
<div class="stats" id="stats">Loading…</div>
<div id="table-container"><p class="empty">Loading sessions…</p></div>
<script>
async function load() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    const stats = document.getElementById('stats');
    const container = document.getElementById('table-container');
    const counts = { dormant: 0, active: 0, busy: 0 };
    sessions.forEach(s => counts[s.state] = (counts[s.state] || 0) + 1);
    stats.innerHTML = \`
      <span>Total: <strong>\${sessions.length}</strong></span>
      <span class="badge badge-dormant">Dormant \${counts.dormant || 0}</span>
      <span class="badge badge-active">Active \${counts.active || 0}</span>
      <span class="badge badge-busy">Busy \${counts.busy || 0}</span>
    \`;
    if (sessions.length === 0) {
      container.innerHTML = '<p class="empty">No sessions yet.</p>';
      return;
    }
    container.innerHTML = '<table><thead><tr>' +
      '<th>State</th><th>Session</th><th>Thread</th><th>Mode</th><th>Trigger</th><th>Work Dir</th><th>Last Active</th><th>Queue</th>' +
      '</tr></thead><tbody>' +
      sessions.map(s => {
        const when = new Date(s.lastActive).toLocaleString();
        return \`<tr>
          <td><span class="badge badge-\${s.state}">\${s.state}</span></td>
          <td class="mono">\${s.sessionId.slice(0,8)}</td>
          <td class="mono">\${s.threadId.slice(0,8)}…</td>
          <td>\${s.mode}</td>
          <td>\${s.trigger}</td>
          <td class="mono">\${s.workDir}</td>
          <td>\${when}</td>
          <td>\${s.queueDepth}</td>
        </tr>\`;
      }).join('') +
      '</tbody></table>';
  } catch (e) {
    document.getElementById('table-container').innerHTML = '<p class="empty">Error loading sessions.</p>';
  }
}
load();
setInterval(load, 2000);
</script>
</body>
</html>`;

export function startDashboard() {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getSessionsData()));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  server.listen(PORT, () => {
    console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  });
}

import http from "node:http";
import crypto from "node:crypto";
import { SessionManager } from "./session.js";
import { listAllSessions } from "./db.js";
import { CONFIG } from "./config.js";

const PORT = CONFIG.dashboardPort;
const SESSION_COOKIE = "kimicord_session";

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

function renderHtml(nonce: string): string {
  return `<!DOCTYPE html>
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
<script nonce="${nonce}">
function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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
          <td><span class="badge badge-\${esc(s.state)}">\${esc(s.state)}</span></td>
          <td class="mono">\${esc(s.sessionId.slice(0,8))}</td>
          <td class="mono">\${esc(s.threadId.slice(0,8))}…</td>
          <td>\${esc(s.mode)}</td>
          <td>\${esc(s.trigger)}</td>
          <td class="mono">\${esc(s.workDir)}</td>
          <td>\${esc(when)}</td>
          <td>\${esc(s.queueDepth)}</td>
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
}

const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kimi Discord Bridge — Login</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 2rem; display: flex; justify-content: center; }
  form { margin-top: 4rem; display: flex; flex-direction: column; gap: 0.75rem; width: 20rem; }
  h1 { margin: 0; font-size: 1.25rem; }
  input, button { padding: 0.5rem 0.75rem; border-radius: 0.375rem; border: 1px solid #1e293b; background: #1e293b; color: #e2e8f0; font-size: 0.9rem; }
  button { background: #2563eb; border: none; cursor: pointer; }
  .error { color: #f87171; font-size: 0.85rem; }
</style>
</head>
<body>
<form method="POST" action="/login">
  <h1>🤖 Kimi Discord Bridge</h1>
  <input type="password" name="key" placeholder="Dashboard API key" autofocus required>
  <button type="submit">Log in</button>
  {{ERROR}}
</form>
</body>
</html>`;

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

/** Constant-time key comparison without leaking the key length. */
function keyMatches(candidate: string): boolean {
  if (!CONFIG.dashboardApiKey) return false;
  try {
    return crypto.timingSafeEqual(sha256(candidate), sha256(CONFIG.dashboardApiKey));
  } catch {
    return false;
  }
}

function sessionCookieValue(): string {
  // The cookie stores a hash of the key, never the key itself.
  return sha256(CONFIG.dashboardApiKey ?? "").toString("hex");
}

function hasBearerAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return !!auth && auth.startsWith("Bearer ") && keyMatches(auth.slice(7));
}

function hasSessionCookie(req: http.IncomingMessage): boolean {
  if (!CONFIG.dashboardApiKey) return false;
  const header = req.headers.cookie;
  if (!header) return false;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(sessionCookieValue()));
    } catch {
      return false;
    }
  }
  return false;
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true ||
    req.headers["x-forwarded-proto"] === "https";
}

function securityHeaders(nonce: string): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function redirect(res: http.ServerResponse, location: string) {
  res.writeHead(303, { Location: location });
  res.end();
}

function sendLoginPage(res: http.ServerResponse, error?: string) {
  res.writeHead(error ? 401 : 200, {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(loginHtml.replace("{{ERROR}}", error ? `<p class="error">${error}</p>` : ""));
}

export function startDashboard(): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const nonce = crypto.randomBytes(16).toString("base64");

    if (url.pathname === "/login") {
      if (req.method === "GET") {
        sendLoginPage(res);
        return;
      }
      if (req.method === "POST") {
        readBody(req)
          .then((body) => {
            const key = new URLSearchParams(body).get("key") ?? "";
            if (!keyMatches(key)) {
              sendLoginPage(res, "Invalid API key.");
              return;
            }
            const secure = isSecureRequest(req) ? "; Secure" : "";
            res.writeHead(303, {
              Location: "/",
              "Set-Cookie": `${SESSION_COOKIE}=${sessionCookieValue()}; HttpOnly; SameSite=Strict; Path=/${secure}`,
            });
            res.end();
          })
          .catch(() => {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request");
          });
        return;
      }
      res.writeHead(405, { "Content-Type": "text/plain", Allow: "GET, POST" });
      res.end("Method Not Allowed");
      return;
    }

    if (url.pathname === "/api/sessions") {
      if (!hasBearerAuth(req) && !hasSessionCookie(req)) {
        res.writeHead(401, {
          "Content-Type": "text/plain",
          "WWW-Authenticate": 'Bearer realm="kimicord-dashboard"',
        });
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...securityHeaders(nonce),
      });
      res.end(JSON.stringify(getSessionsData()));
      return;
    }

    // Browser UI: session cookie required (browsers cannot send Bearer headers).
    if (!hasSessionCookie(req)) {
      redirect(res, "/login");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html", ...securityHeaders(nonce) });
    res.end(renderHtml(nonce));
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Dashboard failed to start: port ${PORT} is already in use. Set DASHBOARD_PORT to a free port.`);
    } else {
      console.error(`Dashboard server error: ${err.message}`);
    }
  });

  server.listen(PORT, () => {
    console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  });

  return server;
}

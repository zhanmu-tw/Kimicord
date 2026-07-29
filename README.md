<p align="center">
  <img src="assets/slightly_terrifying_logo.png" alt="Kimicord logo" width="300">
</p>

# Kimicord

A Discord bot that bridges Discord threads to [Kimi Code CLI](https://www.moonshot.cn/) sessions via [ACP](https://agentclientprotocol.com) (Agent Client Protocol).

> ⭐ If you find Kimicord useful, please consider leaving a star on the repository — it really helps!

**Why Kimicord?** After trying other agents like Hermes, OpenClaw, and more, I wanted a solid coding agent that could live inside Discord. That way I can forward issues from my self-hosted Gitea straight to a bot and have it carry out the work. Kimi Code CLI's ACP mode made this possible — I can even run my own self hosted models just by changing the kimi `config.toml`

## Features

- **Channel mode** — respond to @mentions or all messages in configured channels
- **Forum mode** — auto-reply to new forum posts
- **Slash commands** — `/new`, `/interrupt`, `/stop`, `/status`, `/workdir`, `/sessions`, `/compact`, `/clear`, `/yolo`, `/plan`, `/add-dir`, `/export`, `/init`, `/test`
- **Dashboard** — lightweight HTTP dashboard for live session stats
- **MCP support** — auto-detects `mcp.json` (configurable via `MCP_CONFIG_PATH`) and passes it to `kimi`
- **Attachments** — images (≤10 MB) are forwarded as vision input; all attachments (≤25 MB) are saved under `.kimicord/attachments/` in the workspace for the agent to read
- **Plan progress** — Kimi's plan/todo updates render as a live 📋 checklist message in the thread

## Quick start

1. Copy the example environment file and fill in your values:

   ```bash
   cp .env.example .env
   ```

2. Use the pre-built image from GitHub Container Registry with Docker Compose:

   ```yaml
   services:
     kimicord:
       image: ghcr.io/zhanmu-tw/kimicord:latest
       init: true
       environment:
         DISCORD_TOKEN: ${DISCORD_TOKEN}
         DISCORD_APP_ID: ${DISCORD_APP_ID}
         GUILD_ID: ${GUILD_ID}
         ALLOWED_USER_IDS: ${ALLOWED_USER_IDS}
         CHANNEL_MODE_IDS: ${CHANNEL_MODE_IDS}
         FORUM_MODE_IDS: ${FORUM_MODE_IDS}
         KIMI_WORK_DIR: ${KIMI_WORK_DIR:-/workspace}
         KIMI_YOLO: ${KIMI_YOLO:-false}
         SESSION_IDLE_TIMEOUT_MS: ${SESSION_IDLE_TIMEOUT_MS:-1800000}
         SHOW_THINKING: ${SHOW_THINKING:-false}
         SHOW_STATUS_EMBED: ${SHOW_STATUS_EMBED:-false}
         SHOW_TOOL_OUTPUT: ${SHOW_TOOL_OUTPUT:-true}
         DASHBOARD_PORT: ${DASHBOARD_PORT:-3000}
         DASHBOARD_API_KEY: ${DASHBOARD_API_KEY}
         MCP_CONFIG_PATH: ${MCP_CONFIG_PATH:-/app/data/mcp.json}
       ports:
         - "${DASHBOARD_PORT:-3000}:${DASHBOARD_PORT:-3000}"
       volumes:
         # The container runs as the non-root `node` user (uid 1000); the host
         # directories must be writable by that uid:
         #   mkdir -p kimicord/data kimicord/.kimi-code kimicord/workspace
         #   chown -R 1000:1000 kimicord
         - ./kimicord/data:/app/data
         # The new Kimi Code CLI stores its config in ~/.kimi-code.
         - ./kimicord/.kimi-code:/home/node/.kimi-code
         # Persistent agent workspace; matches KIMI_WORK_DIR above.
         - ./kimicord/workspace:/workspace
       restart: unless-stopped
   ```

   Save it as `docker-compose.yml` and run:

   ```bash
   docker compose up -d
   ```

   Or build from source instead:

   ```bash
   docker compose up --build -d
   ```

   The image is based on Node 24 and ships the new Node-based Kimi Code CLI,
   which stores its configuration in `~/.kimi-code` inside the container
   (mounted from `./kimicord/.kimi-code` on the host).

3. Log in to Kimi Code CLI inside the container (device-code flow — follow the
   URL it prints):

   ```bash
   docker compose exec kimicord bash
   kimi login
   ```

   Headless alternative: instead of `kimi login`, put an API key in
   `./kimicord/.kimi-code/config.toml` on the host:

   ```toml
   [providers.kimi.env]
   KIMI_API_KEY = "sk-..."
   ```

   Note: the CLI reads `KIMI_API_KEY` from this config file, not from the
   process environment.

4. Restart the bot if needed:
   ```bash
   docker compose restart
   ```

## Upgrading

- **Workspace mount moved (breaking):** all host state now lives under
  `kimicord/`. If you used the old dev compose with a top-level `./workspace`
  mount, move your data first: `mv workspace kimicord/workspace`. The prod
  compose now also mounts `kimicord/workspace` — create it writable by
  uid 1000 (`mkdir -p kimicord/workspace && chown 1000:1000 kimicord/workspace`)
  before recreating the container, or Docker creates it root-owned and the
  agent cannot write to it.

## Slash commands

| Command            | Description                                                             |
| ------------------ | ----------------------------------------------------------------------- |
| `/new [prompt]`    | Force-start a new session in the current thread                         |
| `/interrupt`       | Interrupt the current turn without killing the session                  |
| `/stop`            | Cancel the current turn and kill the session                            |
| `/status`          | Show session info                                                       |
| `/workdir <path>`  | Set working directory for the thread's next session                     |
| `/sessions`        | List all sessions (admin only)                                          |
| `/compact [focus]` | Compact the Kimi context                                                |
| `/clear`           | Clear the Kimi context                                                  |
| `/yolo`            | Toggle YOLO mode                                                        |
| `/plan [mode]`     | Toggle or view plan mode                                                |
| `/model`           | Choose the Kimi model                                                   |
| `/effort`          | Choose the thinking effort                                              |
| `/mode`            | Choose the permission mode                                              |
| `/add-dir <path>`  | Add a directory to the workspace                                        |
| `/export`          | Export current context and upload it as a Discord file attachment       |
| `/init`            | Generate `AGENTS.md` via Kimi                                           |
| `/test <type>`     | Send a test request (`approval`, `toolcall`, `question`, `multiselect`) |

## Environment variables

See `.env.example` for all available options and defaults.

## Agent instructions (AGENTS.md)

Kimi Code reads `AGENTS.md` instruction files, and both levels are reachable
through the volume mounts:

- **Global (all sessions):** `kimicord/.kimi-code/AGENTS.md` on the host. On
  first start the entrypoint seeds this from `AGENTS.md.example` (a briefing
  on the container environment, available commands, and how replies render in
  Discord) if you haven't created one. Edit it freely — it is never
  overwritten.
- **Per-project:** an `AGENTS.md` at the root of whatever you mount as
  `kimicord/workspace` (or inside individual project directories under it)
  applies to sessions working in that tree.

## Security considerations

- **Arbitrary code execution:** Any Discord user listed in `ALLOWED_USER_IDS` can execute arbitrary shell commands on the host via Kimi's built-in tool system. Run Kimicord inside a container with minimal privileges and restrict volume mounts to only what is necessary.
- **Path traversal:** `/workdir` and `/add-dir` are sanitized so they cannot escape `KIMI_WORK_DIR`. Keep your volume mounts tight to minimize blast radius.
- **Dashboard exposure:** The HTTP dashboard exposes live session metadata. Set `DASHBOARD_API_KEY` if the dashboard port is reachable from untrusted networks.
- **Secret management:** Do not commit `.env` to version control. In production, prefer Docker secrets, a vault, or your orchestrator's secret injection. Rotate Discord tokens regularly.

## License

MIT

<p align="center">
  <img src="assets/slightly_terrifying_logo.png" alt="Kimicord logo" width="300">
</p>

# Kimicord

A Discord bot that bridges Discord threads to [Kimi CLI](https://www.moonshot.cn/) sessions via Wire mode.

> ⭐ If you find Kimicord useful, please consider leaving a star on the repository — it really helps!

**Why Kimicord?** After trying other agents like Hermes, OpenClaw, and more, I wanted a solid coding agent that could live inside Discord. That way I can forward issues from my self-hosted Gitea straight to a bot and have it carry out the work. Kimi CLI's Wire mode made this possible — I can even run my own self hosted models (like Qwen 3.5 35B) just by changing the kimi config.yaml

## Features

- **Channel mode** — respond to @mentions or all messages in configured channels
- **Forum mode** — auto-reply to new forum posts
- **Slash commands** — `/new`, `/interrupt`, `/stop`, `/status`, `/workdir`, `/sessions`, `/compact`, `/clear`, `/yolo`, `/plan`, `/add-dir`, `/export`, `/init`, `/test`
- **Dashboard** — lightweight HTTP dashboard for live session stats
- **MCP support** — auto-detects `mcp.json` (configurable via `MCP_CONFIG_PATH`) and passes it to `kimi`

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
       environment:
         DISCORD_TOKEN: ${DISCORD_TOKEN}
         DISCORD_APP_ID: ${DISCORD_APP_ID}
         GUILD_ID: ${GUILD_ID}
         ALLOWED_USER_IDS: ${ALLOWED_USER_IDS}
         CHANNEL_MODE_IDS: ${CHANNEL_MODE_IDS}
         FORUM_MODE_IDS: ${FORUM_MODE_IDS}
         KIMI_WORK_DIR: ${KIMI_WORK_DIR:-/workspace}
         KIMI_MODEL: ${KIMI_MODEL:-kimi-k2.5}
         KIMI_YOLO: ${KIMI_YOLO:-false}
         SESSION_IDLE_TIMEOUT_MS: ${SESSION_IDLE_TIMEOUT_MS:-1800000}
         SHOW_THINKING: ${SHOW_THINKING:-false}
         SHOW_STATUS_EMBED: ${SHOW_STATUS_EMBED:-false}
       ports:
         - "${DASHBOARD_PORT:-3000}:${DASHBOARD_PORT:-3000}"
       volumes:
         - ./data:/app/data
         - ./kimi-data:/root/.kimi
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

3. Log in to Kimi CLI inside the container:

   ```bash
   docker compose exec kimicord bash
   kimi login
   ```

4. Restart the bot if needed:
   ```bash
   docker compose restart
   ```

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
| `/add-dir <path>`  | Add a directory to the workspace                                        |
| `/export`          | Export current context and upload it as a Discord file attachment       |
| `/init`            | Generate `AGENTS.md` via Kimi                                           |
| `/test <type>`     | Send a test request (`approval`, `toolcall`, `question`, `multiselect`) |

## Environment variables

See `.env.example` for all available options and defaults.

## Security considerations

- **Arbitrary code execution:** Any Discord user listed in `ALLOWED_USER_IDS` can execute arbitrary shell commands on the host via Kimi's built-in tool system. Run Kimicord inside a container with minimal privileges and restrict volume mounts to only what is necessary.
- **Path traversal:** `/workdir` and `/add-dir` are sanitized so they cannot escape `KIMI_WORK_DIR`. Keep your volume mounts tight to minimize blast radius.
- **Dashboard exposure:** The HTTP dashboard exposes live session metadata. Set `DASHBOARD_API_KEY` if the dashboard port is reachable from untrusted networks.
- **Secret management:** Do not commit `.env` to version control. In production, prefer Docker secrets, a vault, or your orchestrator's secret injection. Rotate Discord tokens regularly.

## License

MIT

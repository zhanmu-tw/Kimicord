# Kimicord

A Discord bot that bridges Discord threads to [Kimi CLI](https://www.moonshot.cn/) sessions via Wire mode.

## Features

- **Channel mode** — respond to @mentions or all messages in configured channels
- **Forum mode** — auto-reply to new forum posts
- **Slash commands** — `/new`, `/stop`, `/status`, `/workdir`, `/sessions`, `/compact`, `/clear`, `/yolo`, `/plan`, `/add-dir`, `/export`, `/init`
- **Dashboard** — lightweight HTTP dashboard for live session stats
- **MCP support** — auto-detects `/app/data/mcp.json` and passes it to `kimi`

## Quick start

1. Copy the example environment file and fill in your values:
   ```bash
   cp .env.example .env
   ```

2. Use the pre-built image from GitHub Container Registry with Docker Compose:
   ```yaml
   services:
     kimicord:
       image: ghcr.io/zhanmu-tw/kimicord:1.0.0
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

## Environment variables

See `.env.example` for all available options and defaults.

## License

MIT

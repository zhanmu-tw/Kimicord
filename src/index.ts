import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import type { Server } from "node:http";
import { CONFIG } from "./config.js";
import { SessionManager } from "./session.js";
import { listAllSessions } from "./db.js";
import { registerCommands, attachBotHandlers } from "./bot.js";
import { startDashboard } from "./dashboard.js";

let client: Client | null = null;
let dashboardServer: Server | null = null;
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down…`);
  try {
    SessionManager.destroyAll();
  } catch (e) {
    console.error("Error destroying sessions:", e);
  }
  // NOTE: db.ts does not export a close handle; better-sqlite3 is synchronous
  // and WAL-flushes on each write, so exiting is safe.
  try {
    dashboardServer?.close();
  } catch (e) {
    console.error("Error closing dashboard server:", e);
  }
  try {
    client?.destroy();
  } catch (e) {
    console.error("Error destroying Discord client:", e);
  }
  process.exit(0);
}

async function main() {
  dashboardServer = startDashboard();

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // GatewayIntentBits.GuildMembers is not needed
    ],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      console.log(`Logged in as ${readyClient.user.tag}`);
      await registerCommands();

      // Resume dormant sessions. This is lazy: getOrCreate only creates the
      // session object — no `kimi acp` process is spawned until the thread's
      // first message (session/resume happens then, without history replay).
      const rows = listAllSessions();
      for (const row of rows) {
        SessionManager.getOrCreate(row.thread_id, row.session_id, row.work_dir, CONFIG.kimiYolo);
      }
      console.log(`Resumed ${rows.length} dormant sessions`);
    } catch (e) {
      console.error("Fatal error during startup:", e);
      process.exit(1);
    }
  });

  attachBotHandlers(client);

  await client.login(CONFIG.discordToken);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { CONFIG } from "./config.js";
import { SessionManager } from "./session.js";
import { listAllSessions } from "./db.js";
import { registerCommands, attachBotHandlers } from "./bot.js";
import { startDashboard } from "./dashboard.js";

async function main() {
  startDashboard();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // GatewayIntentBits.GuildMembers is not needed
    ],
    partials: [Partials.Channel],
  });

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user?.tag}`);
    await registerCommands();

    // Resume dormant sessions
    const rows = listAllSessions();
    for (const row of rows) {
      SessionManager.getOrCreate(row.thread_id, row.session_id, row.work_dir, CONFIG.kimiYolo);
    }
    console.log(`Resumed ${rows.length} dormant sessions`);
  });

  attachBotHandlers(client);

  await client.login(CONFIG.discordToken);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

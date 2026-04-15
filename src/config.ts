import "dotenv/config";

export type TriggerMode = "mention" | "any";

export interface ChannelConfig {
  channelId: string;
  discordMode: "channel" | "forum";
  trigger: TriggerMode;
}

function parseChannelList(
  raw: string | undefined,
  discordMode: "channel" | "forum",
  defaultTrigger: TriggerMode
): Map<string, ChannelConfig> {
  const map = new Map<string, ChannelConfig>();
  if (!raw) return map;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [channelId, trigger] = trimmed.split(":");
    const t = (trigger as TriggerMode) ?? defaultTrigger;
    if (t !== "mention" && t !== "any") {
      console.error(`Invalid trigger "${t}" for channel ${channelId}`);
      process.exit(1);
    }
    map.set(channelId, { channelId, discordMode, trigger: t });
  }
  return map;
}

const channelRaw = process.env.CHANNEL_MODE_IDS ?? "";
const forumRaw = process.env.FORUM_MODE_IDS ?? "";

const channelConfigs = parseChannelList(channelRaw, "channel", "mention");
const forumConfigs = parseChannelList(forumRaw, "forum", "any");

for (const [id] of channelConfigs) {
  if (forumConfigs.has(id)) {
    console.error(`Channel ID ${id} cannot be in both CHANNEL_MODE_IDS and FORUM_MODE_IDS`);
    process.exit(1);
  }
}

const allConfigs = new Map<string, ChannelConfig>([...channelConfigs, ...forumConfigs]);

export const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN!,
  discordAppId: process.env.DISCORD_APP_ID!,
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  channels: allConfigs,
  kimiWorkDir: process.env.KIMI_WORK_DIR ?? process.env.HOME ?? "/",
  kimiYolo: (process.env.KIMI_YOLO ?? "false").toLowerCase() === "true",
  sessionIdleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 1800000),
  showThinking: (process.env.SHOW_THINKING ?? "true").toLowerCase() === "true",
  showStatusEmbed: (process.env.SHOW_STATUS_EMBED ?? "true").toLowerCase() === "true",
  guildId: process.env.GUILD_ID,
};

if (!CONFIG.discordToken || !CONFIG.discordAppId) {
  console.error("Missing DISCORD_TOKEN or DISCORD_APP_ID");
  process.exit(1);
}

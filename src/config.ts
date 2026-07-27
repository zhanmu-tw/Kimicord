import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export type TriggerMode = "mention" | "any";

export interface ChannelConfig {
  channelId: string;
  discordMode: "channel" | "forum";
  trigger: TriggerMode;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

function fail(message: string): never {
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    fail(`missing required environment variable ${name}. Set it in your environment or .env file.`);
  }
  return value;
}

function parseIntEnv(name: string, defaultValue: number, min = 1, max = 65535): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    fail(`${name} must be a number, got "${raw}".`);
  }
  if (parsed < min || parsed > max) {
    fail(`${name} must be between ${min} and ${max}, got ${parsed}.`);
  }
  return parsed;
}

function warnIfNotSnowflake(envName: string, value: string): void {
  if (!SNOWFLAKE_RE.test(value)) {
    console.warn(`WARNING: ${envName} entry "${value}" does not look like a Discord snowflake (expected 17-20 digits).`);
  }
}

function parseChannelList(
  raw: string | undefined,
  envName: string,
  discordMode: "channel" | "forum",
  defaultTrigger: TriggerMode
): Map<string, ChannelConfig> {
  const map = new Map<string, ChannelConfig>();
  if (!raw) return map;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const segments = trimmed.split(":");
    if (segments.length > 2) {
      fail(`${envName} entry "${trimmed}" has too many ":" segments. Expected "<id>" or "<id>:<trigger>".`);
    }
    const [channelId, trigger] = segments;
    if (!channelId) {
      fail(`${envName} entry "${trimmed}" is missing a channel ID before the ":".`);
    }
    if (trigger === "") {
      fail(`${envName} entry "${trimmed}" has an empty trigger. Use "mention" or "any", or drop the ":" suffix.`);
    }
    const t = (trigger ?? defaultTrigger) as TriggerMode;
    if (t !== "mention" && t !== "any") {
      fail(`${envName} entry "${trimmed}" has invalid trigger "${trigger}". Use "mention" or "any".`);
    }
    warnIfNotSnowflake(envName, channelId);
    map.set(channelId, { channelId, discordMode, trigger: t });
  }
  return map;
}

// ---- Validate first, then export typed values ----

const discordToken = requiredEnv("DISCORD_TOKEN");
const discordAppId = requiredEnv("DISCORD_APP_ID");

const sessionIdleTimeoutMs = parseIntEnv("SESSION_IDLE_TIMEOUT_MS", 1800000, 0, Number.MAX_SAFE_INTEGER);
const dashboardPort = parseIntEnv("DASHBOARD_PORT", 3000);

const channelConfigs = parseChannelList(process.env.CHANNEL_MODE_IDS, "CHANNEL_MODE_IDS", "channel", "mention");
const forumConfigs = parseChannelList(process.env.FORUM_MODE_IDS, "FORUM_MODE_IDS", "forum", "any");

for (const [id] of channelConfigs) {
  if (forumConfigs.has(id)) {
    fail(`channel ID ${id} cannot be in both CHANNEL_MODE_IDS and FORUM_MODE_IDS.`);
  }
}

const allConfigs = new Map<string, ChannelConfig>([...channelConfigs, ...forumConfigs]);

const allowedUserIds = new Set(
  (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
for (const id of allowedUserIds) {
  warnIfNotSnowflake("ALLOWED_USER_IDS", id);
}

const guildId = process.env.GUILD_ID || undefined;
if (guildId) {
  warnIfNotSnowflake("GUILD_ID", guildId);
}

export const CONFIG = {
  discordToken,
  discordAppId,
  allowedUserIds,
  channels: allConfigs,
  kimiWorkDir: process.env.KIMI_WORK_DIR || process.env.HOME || "/",
  kimiYolo: (process.env.KIMI_YOLO ?? "false").toLowerCase() === "true",
  sessionIdleTimeoutMs,
  showThinking: (process.env.SHOW_THINKING ?? "false").toLowerCase() === "true",
  showStatusEmbed: (process.env.SHOW_STATUS_EMBED ?? "false").toLowerCase() === "true",
  showToolOutput: (process.env.SHOW_TOOL_OUTPUT ?? "true").toLowerCase() === "true",
  guildId,
  mcpConfigPath: process.env.MCP_CONFIG_PATH || "/app/data/mcp.json",
  dashboardApiKey: process.env.DASHBOARD_API_KEY || undefined,
  dashboardPort,
};

if (CONFIG.allowedUserIds.size === 0) {
  console.warn("=".repeat(78));
  console.warn("WARNING: ALLOWED_USER_IDS is empty — NO Discord user will be authorized to");
  console.warn("interact with the bot. Set ALLOWED_USER_IDS to a comma-separated list of");
  console.warn("Discord user IDs in your environment or .env file.");
  console.warn("=".repeat(78));
}

/** Resolve symlinks for the nearest existing ancestor of `p`. */
function realpathNearest(p: string): string {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.reduceRight((acc, seg) => path.join(acc, seg), real);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function sanitizeWorkDir(input: string): string {
  if (input.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
  if (/[;|&$`\n\r]/.test(input)) {
    throw new Error("Path contains invalid shell characters");
  }
  const base = path.resolve(CONFIG.kimiWorkDir);
  const resolved = path.resolve(base, input);
  // Resolve symlinks so a link inside KIMI_WORK_DIR pointing outside is rejected.
  const realBase = realpathNearest(base);
  const realResolved = realpathNearest(resolved);
  const relative = path.relative(realBase, realResolved);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

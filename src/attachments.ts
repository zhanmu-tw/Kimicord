import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Message } from "discord.js";
import { AcpPromptContentBlock } from "./wire.js";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_MAX_BYTES = 25 * 1024 * 1024;

export interface ProcessedAttachments {
  imageBlocks: AcpPromptContentBlock[];
  /** Text appended to the prompt: saved paths plus per-attachment skip notes. */
  textSuffix: string;
}

/**
 * Download a message's attachments. Images ride the prompt as ACP image
 * blocks; everything downloaded is also saved under
 * <workDir>/.kimicord/attachments/ (inside the KIMI_WORK_DIR confinement) so
 * the agent can Read/ReadMediaFile it. Oversized or failed downloads become
 * notes in the text instead of failing the prompt.
 */
export async function processAttachments(message: Message, workDir: string): Promise<ProcessedAttachments> {
  if (message.attachments.size === 0) return { imageBlocks: [], textSuffix: "" };

  const imageBlocks: AcpPromptContentBlock[] = [];
  const savedPaths: string[] = [];
  const notes: string[] = [];
  const dir = path.join(workDir, ".kimicord", "attachments");
  mkdirSync(dir, { recursive: true });

  for (const attachment of message.attachments.values()) {
    const name = attachment.name ?? "file";
    const isImage = attachment.contentType?.startsWith("image/") ?? false;
    const cap = isImage ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
    if (attachment.size > cap) {
      notes.push(`[Skipped attachment ${name}: too large]`);
      continue;
    }
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > cap) {
        notes.push(`[Skipped attachment ${name}: too large]`);
        continue;
      }
      const filePath = path.join(dir, `${message.id}-${sanitizeFilename(name)}`);
      await writeFile(filePath, buffer);
      savedPaths.push(filePath);
      if (isImage && attachment.contentType) {
        imageBlocks.push({ type: "image", data: buffer.toString("base64"), mimeType: attachment.contentType });
      }
    } catch {
      notes.push(`[Skipped attachment ${name}: download failed]`);
    }
  }

  const parts: string[] = [];
  if (savedPaths.length > 0) parts.push(`[User attachments saved to: ${savedPaths.join(", ")}]`);
  parts.push(...notes);
  return { imageBlocks, textSuffix: parts.length > 0 ? "\n\n" + parts.join("\n") : "" };
}

function sanitizeFilename(name: string): string {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "file";
}

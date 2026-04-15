import { ThreadChannel, EmbedBuilder } from "discord.js";
import { KimiSession } from "./session.js";
import { TurnRenderer } from "./renderer.js";
import { postApproval, postQuestion, postToolCallRequest } from "./approvals.js";
import { getSessionByThread } from "./db.js";
import { WireEventMessage } from "./wire.js";

export async function runTurn(session: KimiSession, thread: ThreadChannel, text: string) {
  const row = getSessionByThread(thread.id);
  const renderer = new TurnRenderer(
    thread,
    session.sessionId,
    row?.mode ?? "channel",
    row?.trigger ?? "mention",
    session.workDir,
    session.yolo
  );
  await renderer.init();

  const onEvent = (event: WireEventMessage) => renderer.handleEvent(event);
  const onRequest = async (req: { wireRequestId: string; type: string; payload: unknown }) => {
    if (req.type === "ApprovalRequest") {
      await postApproval(
        thread,
        session,
        req.wireRequestId,
        req.payload as { action: string; description?: string; command?: unknown }
      );
    } else if (req.type === "QuestionRequest") {
      await postQuestion(
        thread,
        session,
        req.wireRequestId,
        req.payload as { question: string; suggestions?: string[] }
      );
    } else if (req.type === "ToolCallRequest") {
      await postToolCallRequest(thread, session, req.wireRequestId, req.payload);
    }
  };
  const onCrashed = async () => {
    await thread.send({
      embeds: [new EmbedBuilder().setTitle("❌ Session Error").setDescription("Session crashed.").setColor(0xdc2626)],
    });
    renderer.updateStatus("🔴 Error").catch(() => {});
  };
  const onDormant = async () => {
    await renderer.updateStatus("💤 Dormant");
  };

  session.on("event", onEvent);
  session.on("request", onRequest);
  session.on("crashed", onCrashed);
  session.on("dormant", onDormant);

  const cleanup = () => {
    session.off("event", onEvent);
    session.off("request", onRequest);
    session.off("crashed", onCrashed);
    session.off("dormant", onDormant);
  };

  await thread.sendTyping();
  try {
    await session.sendPrompt(text);
  } catch (err) {
    cleanup();
    const code = (err as Error & { code?: number }).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === -32001 || msg.toLowerCase().includes("llm is not set")) {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚠️ LLM Not Configured")
            .setDescription(
              "Kimi CLI doesn't have an LLM configured. Please run the following inside the container:\n\n" +
                "```bash\nkimi login\n```"
            )
            .setColor(0xf59e0b),
        ],
      });
    } else {
      await thread.send({
        embeds: [new EmbedBuilder().setTitle("❌ Session Error").setDescription(msg).setColor(0xdc2626)],
      });
    }
    return;
  }
  cleanup();
}

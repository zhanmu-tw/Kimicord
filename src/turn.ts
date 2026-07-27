import { ThreadChannel, EmbedBuilder, Message } from "discord.js";
import { KimiSession } from "./session.js";
import { TurnRenderer } from "./renderer.js";
import { postApproval, postQuestion, postToolCallRequest } from "./approvals.js";
import { getSessionByThread } from "./db.js";
import { WireEventMessage, QuestionRequestPayload, ACP_ERROR_AUTH_REQUIRED } from "./wire.js";
import { safeErrorReply } from "./errors.js";

export async function runTurn(session: KimiSession, thread: ThreadChannel, text: string, triggerMessage?: Message): Promise<TurnRenderer> {
  const row = getSessionByThread(thread.id);
  const renderer = new TurnRenderer(
    thread,
    session.sessionId,
    row?.mode ?? "channel",
    row?.trigger ?? "mention",
    session.workDir,
    session.yolo
  );

  // EventEmitter does not await async listeners — wrap them so rejections are
  // caught and logged instead of becoming unhandled rejections.
  const guard = (label: string, fn: () => Promise<void>) => {
    fn().catch(async (e) => {
      console.error(`[runTurn] ${label} failed:`, e);
      await thread.send({
        embeds: [new EmbedBuilder().setTitle("❌ Session Error").setDescription(safeErrorReply(e)).setColor(0xdc2626)],
      }).catch(() => {});
    });
  };

  const onEvent = (event: WireEventMessage) => {
    try {
      renderer.handleEvent(event);
    } catch (e) {
      console.error("[runTurn] event handling failed:", e);
    }
  };
  const onRequest = (req: { wireRequestId: string; type: string; payload: unknown }) =>
    guard("request handler", async () => {
      if (req.type === "ApprovalRequest") {
        await postApproval(
          thread,
          session,
          req.wireRequestId,
          req.payload as { action: string; description?: string; command?: unknown }
        );
        await renderer.updateStatus("⏸️ Waiting for approval");
      } else if (req.type === "QuestionRequest") {
        await postQuestion(
          thread,
          session,
          req.wireRequestId,
          req.payload as QuestionRequestPayload
        );
        await renderer.updateStatus("⏸️ Waiting for answer");
      } else if (req.type === "ToolCallRequest") {
        await postToolCallRequest(thread, session, req.wireRequestId, req.payload);
        await renderer.updateStatus("⏸️ Waiting for approval");
      }
    });
  const onCrashed = () =>
    guard("crash handler", async () => {
      // No error embed here: the crash rejects the pending prompt and the
      // catch block below reports it — reporting in both places double-posts.
      await renderer.updateStatus("🔴 Error");
    });
  const onDormant = () =>
    guard("dormant handler", async () => {
      await renderer.updateStatus("💤 Dormant");
    });

  session.on("event", onEvent);
  session.on("request", onRequest);
  session.once("crashed", onCrashed);
  session.once("dormant", onDormant);

  const cleanup = () => {
    session.off("event", onEvent);
    session.off("request", onRequest);
    session.off("crashed", onCrashed);
    session.off("dormant", onDormant);
  };

  const typingInterval = setInterval(() => {
    thread.sendTyping().catch(() => {});
  }, 8000);

  try {
    await renderer.init();

    if (triggerMessage) {
      await triggerMessage.react("👀").catch(() => {});
    }

    await thread.sendTyping();
    await session.sendPrompt(text);
  } catch (err) {
    // If this turn was dequeued but failed before its prompt was dispatched,
    // free the reserved handoff slot so the session doesn't deadlock.
    session.releaseHandoff();
    const code = (err as Error & { code?: number }).code;
    if (code === ACP_ERROR_AUTH_REQUIRED) {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("⚠️ Kimi Not Authenticated")
            .setDescription(
              "Kimi CLI has no credentials. Run the following on the host (or inside the container):\n\n" +
                "```bash\nkimi login\n```\n" +
                "Or set an API key in `~/.kimi-code/config.toml` (`[providers.kimi.env]` → `KIMI_API_KEY`)."
            )
            .setColor(0xf59e0b),
        ],
      });
    } else {
      await thread.send({
        embeds: [new EmbedBuilder().setTitle("❌ Session Error").setDescription(safeErrorReply(err)).setColor(0xdc2626)],
      });
    }
  } finally {
    clearInterval(typingInterval);
    cleanup();
    if (triggerMessage) {
      triggerMessage.reactions.cache.get("👀")?.users.remove(triggerMessage.client.user!.id).catch(() => {});
    }
  }
  return renderer;
}

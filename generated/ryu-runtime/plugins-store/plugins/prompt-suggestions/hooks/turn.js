// Runtime body for @ryu/prompt-suggestions. Core injects ctx and host.
// This is deliberately a tiny background call: it never blocks or changes the
// assistant turn. The desktop reads the same conversation-scoped cache through
// the chat-suggestions bridge.
const conversationId = ctx.conversation_id;
if (!conversationId || !ctx.transcript || !(await enabled())) {
  return { kind: "none" };
}

const transcript = ctx.transcript
  .filter((message) => message.role === "user" || message.role === "assistant")
  .slice(-8)
  .map((message) => `${message.role}: ${String(message.content || "").slice(-1200)}`)
  .join("\n\n")
  .slice(-6000);
if (!transcript) {
  return { kind: "none" };
}

const raw = await host.sideModel({
  model_pref_key: "chat-suggestions-model",
  system: "Return up to 3 short next prompts for the user, one per line. 3-10 words each. No bullets, numbering, quotes, or explanation.",
  prompt: `Conversation:\n\n${transcript}\n\nNext prompts:`,
});
const suggestions = String(raw || "")
  .split("\n")
  .map((line) => line.replace(/^[-*\d.)]+\s*/, "").trim())
  .filter((line) => line.length >= 3 && line.length <= 100)
  .slice(0, 3);
if (suggestions.length > 0) {
  await host.storage.set(`prompt-suggestions:${conversationId}`, JSON.stringify({ suggestions }));
}
return { kind: "none" };

async function enabled() {
  try {
    return (await host.getPreference({ key: "chat-suggestions-enabled" })) !== "false";
  } catch {
    return true;
  }
}

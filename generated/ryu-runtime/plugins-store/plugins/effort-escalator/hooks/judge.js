// Turn-hook fragment for Effort Escalator. `ctx` and `host` are injected by Core.
const id = ctx.conversation_id;
if (!id) return { kind: "none" };
const enabled = String(await host.getPreference({ key: "effort-escalator-enabled" }) ?? "false") === "true";
if (!enabled) return { kind: "none" };
let rules;
try { rules = JSON.parse(String(await host.getPreference({ key: "effort-escalator-rules" }) ?? "{}")); } catch (_error) { return { kind: "none" }; }
const rule = rules?.agents?.[ctx.agent_id] ?? rules?.global;
if (!rule?.ladder?.length) return { kind: "none" };
function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}
function boundedInteger(value, fallback, minimum, maximum) {
  return Math.floor(boundedNumber(value, fallback, minimum, maximum));
}
const key = `effort-escalator:${id}`;
let state = {};
try { state = JSON.parse((await host.storage.get(key)) ?? "{}"); } catch (_error) {}
const now = Date.now();
const afterMinutes = boundedNumber(rule.after_minutes, 30, 1, 24 * 60);
const afterMs = afterMinutes * 60 * 1000;
const checkedAt = Number(state.checked_at);
if (!Number.isFinite(checkedAt)) {
  state = { ...state, checked_at: now };
  await host.storage.set(key, state);
  return { kind: "none" };
}
if (now - checkedAt < afterMs) return { kind: "none" };
const transcript = (Array.isArray(ctx.transcript) ? ctx.transcript : []).slice(-12)
  .map((m) => `${m.role}: ${String(m.content ?? "").slice(0, 1800)}`).join("\n");
if (!transcript) return { kind: "none" };
const verdict = await host.sideModel({
  model_pref_key: "effort-escalator-judge-model",
  system: "You are a cheap, read-only task-progress judge. Return exactly STUCK: yes or STUCK: no, followed by one short reason. Say yes only when the worker is looping, blocked, repeatedly failing, or clearly not making progress toward the user's request.",
  prompt: `<conversation-data>\n${transcript}\n</conversation-data>\nIs the worker stuck?`,
});
const stuck = /^\s*stuck:\s*yes\b/i.test(String(verdict ?? ""));
const ladderLength = rule.ladder.length;
const escalations = boundedInteger(state.escalations, 0, 0, ladderLength);
const maxEscalations = boundedInteger(rule.max_escalations, ladderLength, 0, ladderLength);
state = { checked_at: now, escalations, stuck };
if (!stuck || state.escalations >= maxEscalations) {
  await host.storage.set(key, state);
  return { kind: "none" };
}
state.escalations += 1;
state.reason = String(verdict ?? "").slice(0, 500);
await host.storage.set(key, state);
return { kind: "note", text: `Effort Escalator detected stalled work; the next turn will use escalation ${state.escalations}. ${state.reason}` };

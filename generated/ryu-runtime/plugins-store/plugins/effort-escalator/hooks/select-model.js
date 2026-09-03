// Pre-model-select fragment. Priority 100 makes escalation first-writer-wins
// with Usage Pacer; Core orders hooks by priority before running this body.
const id = ctx.conversation_id;
const requested = String(ctx.event?.model ?? "");
if (!id || !requested) return { kind: "none" };
const enabled = String(await host.getPreference({ key: "effort-escalator-enabled" }) ?? "false") === "true";
if (!enabled) return { kind: "none" };
let state;
try { state = JSON.parse((await host.storage.get(`effort-escalator:${id}`)) ?? "{}"); } catch (_error) { return { kind: "none" }; }
if (!state?.stuck || !Number(state.escalations)) return { kind: "none" };
let rules;
try { rules = JSON.parse(String(await host.getPreference({ key: "effort-escalator-rules" }) ?? "{}")); } catch (_error) { return { kind: "none" }; }
const rule = rules?.agents?.[ctx.agent_id] ?? rules?.global;
if (!rule?.ladder?.length) return { kind: "none" };
const ladderLength = rule.ladder.length;
const parsedEscalations = Number(state.escalations);
if (!Number.isFinite(parsedEscalations)) return { kind: "none" };
const escalations = Math.max(0, Math.floor(parsedEscalations));
const parsedMax = Number(rule.max_escalations);
const maxEscalations = rule.max_escalations == null || !Number.isFinite(parsedMax)
  ? ladderLength
  : Math.min(ladderLength, Math.max(0, Math.floor(parsedMax)));
if (escalations === 0 || escalations > ladderLength || escalations > maxEscalations) return { kind: "none" };
const step = rule.ladder[escalations - 1];
if (!step) return { kind: "none" };
const from = String(step.from ?? "").toLowerCase();
if (from && !requested.toLowerCase().includes(from)) return { kind: "none" };
const target = String(step.to ?? "").trim();
if (!target || target === requested) return { kind: "none" };
const effort = String(step.effort ?? "").trim();
state.stuck = false;
await host.storage.set(`effort-escalator:${id}`, state);
return {
  kind: "select_model",
  model: target,
  effort: effort || undefined,
  reason: `stuck-task escalation ${escalations}${effort ? `; effort ${effort}` : ""}`,
};

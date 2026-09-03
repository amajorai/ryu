// Turn-hook body for `tuition.study`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.getPreference / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// apps-store/*/hooks is excluded from Biome — a module parser rejects it.
//
// What this is: "Study mode". When an assistant turn actually teaches you
// something, the facts it taught become CANDIDATE review items for the active
// subject. Candidates are never accepted here — a person accepts or rejects them
// in the companion, and only then do they become items the mastery model grades
// you on. That restraint is the whole design: a deck you did not choose is a deck
// you stop trusting, and the posterior it produces is then worthless.
//
// WHY IT WRITES TO KV AND NOT TO THE SIDECAR
//
// This sandbox has no HTTP and no capability call, so `ryu-tuition` on :8007 is
// unreachable from here by design. The one channel both sides can touch is the
// plugin's own KV store: a hook reaches it as `host.storage.*`, and the sidecar
// reaches the same rows by POSTing `{method, args}` to Core's `/api/host/rpc`.
// So this hook enqueues and the sidecar drains, on its tick.
//
// The key shape is load-bearing and the sidecar's drain depends on it exactly:
//
//     candidate:<subject_id>:<conversation_id>:<unique>     (default namespace)
//
// Four colon-separated parts, both id parts sanitized below so a colon can never
// appear inside one. Every turn writes its OWN key rather than appending to a
// per-subject key, because the only verbs available are get/set/delete/keys:
// with a shared key, two turns in flight would read-modify-write over each other,
// and a write landing between the sidecar's `get` and its `delete` would be
// deleted unread. One key per turn makes both races impossible — a write during a
// drain is simply picked up on the next tick.
//
// Cost discipline: the checks below run cheapest-first, so a turn that cannot
// produce candidates never pays for the preference round-trip, and never pays for
// the model call.

const MIN_TURN_CHARS = 600;
const MAX_TURN_CHARS = 16_000;
const MAX_CANDIDATES = 8;
const MAX_PROMPT_CHARS = 300;
const MAX_ANSWER_CHARS = 600;
const MAX_SKILL_CHARS = 80;
const ID_CHARS = /[^A-Za-z0-9._-]+/g;

if (!(ctx.flags && ctx.flags["io.ryu.tuition"])) {
	return { kind: "none" };
}

// A short turn is not a lesson. Checked before anything that costs a round-trip:
// "sure, done — the file is updated" is the common case, and a hook that
// manufactures cards from it poisons the deck faster than a bad model would.
const turnText = textSinceLastUserMessage(ctx.transcript || []);
if (turnText.length < MIN_TURN_CHARS) {
	return { kind: "none" };
}

const subjectId = sanitizeId(await preference("tuition-active-subject"));
if (!subjectId) {
	// Silent: the user has Study mode on but has not picked a subject, and there
	// is nothing this hook can do about it mid-turn. Settings → Tuition says so,
	// and nagging on every single turn would just get the toggle switched off.
	return { kind: "none" };
}

let raw;
try {
	raw = await host.sideModel({
		system:
			"You extract review material from a tutoring conversation. You are given " +
			"everything the assistant said in one turn. Return ONLY the facts that turn " +
			"actually TAUGHT — a definition, a rule, a value, a distinction, a mechanism — " +
			"that a learner could later be asked about and answer from memory.\n\n" +
			"Rules:\n" +
			"- Extract only what the text states. Never add knowledge of your own, and never " +
			"turn a claim the text hedged into a fact.\n" +
			"- Skip anything that is not durable knowledge: what the assistant did, file or " +
			"command output, code it wrote, project-specific state, apologies, plans, " +
			"questions back to the user.\n" +
			"- A good question has exactly one defensible answer and does not quote the " +
			"conversation ('What does X do?', not 'What did you just explain about X?').\n" +
			"- At most " +
			MAX_CANDIDATES +
			" items, best first. Fewer is better than padded.\n\n" +
			"Output: a JSON array, nothing else — no prose, no code fence. Each element is " +
			'{"prompt": string, "answer": string, "skill": string} where `skill` is a short ' +
			"topic label two or three words long, reused verbatim across items on the same " +
			"topic.\n\n" +
			"MOST TURNS TEACH NOTHING. If this one did not — it did a task, reported a " +
			"result, asked a question, chatted — return exactly [] . An empty array is the " +
			"correct, expected answer for such a turn, not a failure to try.",
		prompt: turnText,
		model_pref_key: "tuition-generation-model",
	});
} catch (e) {
	host.log("tuition: extracting review candidates failed", e);
	return { kind: "none" };
}

const candidates = parseCandidates(raw);
if (candidates.length === 0) {
	return { kind: "none" };
}

const conversationId = sanitizeId(ctx.conversation_id) || "adhoc";
const key = `candidate:${subjectId}:${conversationId}:${uniqueSuffix()}`;
try {
	await host.storage.set(key, {
		v: 1,
		subject_id: subjectId,
		conversation_id: ctx.conversation_id || null,
		agent_id: ctx.agent_id || null,
		created_at: new Date().toISOString(),
		candidates,
	});
} catch (e) {
	// The queue is the only channel to the sidecar, so a failed write means these
	// candidates are gone. Log it and say nothing: the user asked for a study
	// deck, not for an error banner under an answer they were reading.
	host.log("tuition: queueing review candidates failed", e);
	return { kind: "none" };
}

// The counterpart of never auto-accepting: the deck only grows if the user knows
// it has something waiting, and where to go decide on it.
const noun = candidates.length === 1 ? "candidate" : "candidates";
return {
	kind: "note",
	text: `Study mode — ${candidates.length} review ${noun} queued. Accept or reject them in Tuition.`,
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** A preference, or `null` on any failure (a hook is never worth a turn for). */
async function preference(key) {
	try {
		return await host.getPreference({ key });
	} catch (e) {
		return null;
	}
}

/**
 * Reduce an id to the alphabet the KV key template can carry unambiguously.
 * Empty (or all-punctuation) input yields "", which the caller treats as unset —
 * a key with a blank segment would be undrainable at the other end.
 */
function sanitizeId(value) {
	return String(value == null ? "" : value)
		.trim()
		.replace(ID_CHARS, "")
		.slice(0, 128);
}

/** Enough entropy that two turns in the same conversation cannot collide. */
function uniqueSuffix() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The model's reply as a bounded candidate list. Any doubt — a fence it did not
 * strip, prose around the array, a non-array, a member missing a side — yields
 * [], because a malformed extraction is indistinguishable from an invented one
 * and both belong nowhere near the deck.
 */
function parseCandidates(reply) {
	const text = String(reply == null ? "" : reply).trim();
	if (!text) {
		return [];
	}
	// Models fence JSON even when told not to; take the outermost array either way.
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) {
		return [];
	}
	let parsed;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch (e) {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const out = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const prompt = clamp(entry.prompt, MAX_PROMPT_CHARS);
		const answer = clamp(entry.answer, MAX_ANSWER_CHARS);
		if (!(prompt && answer)) {
			continue;
		}
		out.push({ prompt, answer, skill: clamp(entry.skill, MAX_SKILL_CHARS) });
		if (out.length >= MAX_CANDIDATES) {
			break;
		}
	}
	return out;
}

/** Trimmed, length-bounded string form of a model-supplied field. */
function clamp(value, limit) {
	const s = String(value == null ? "" : value)
		.replace(/\s+/g, " ")
		.trim();
	return s.length > limit ? s.slice(0, limit) : s;
}

/**
 * Everything the assistant said since the last user message — the whole turn,
 * including the extra turns a `continue` directive looped through. Bounded from
 * the END: when a turn is enormous, its closing passages are the ones that state
 * the conclusions worth remembering.
 */
function textSinceLastUserMessage(transcript) {
	let start = -1;
	for (let i = transcript.length - 1; i >= 0; i--) {
		if (transcript[i].role === "user") {
			start = i;
			break;
		}
	}
	const parts = [];
	for (const m of transcript.slice(start + 1)) {
		const content = String(m.content || "").trim();
		if (content) {
			parts.push(content);
		}
	}
	const joined = parts.join("\n\n").trim();
	return joined.length > MAX_TURN_CHARS
		? joined.slice(-MAX_TURN_CHARS)
		: joined;
}

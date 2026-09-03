// Turn-hook body for `receipts.loop`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.runAgent / host.storage / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// The loop is `proof`'s visual sibling. `proof` re-reads the workspace; this one
// demands a durable artifact — a screenshot or a screen recording written to disk —
// and hands it to an INDEPENDENT verifier agent that judges what it can SEE.
//
// Two facts about the sandbox shape the whole design:
//   1. The hook has no HTTP and no callTool. It cannot capture anything itself, so
//      the capture is instructed and the artifact must arrive as an absolute PATH
//      printed in the turn text — `ctx.transcript` carries text only, so an inline
//      image part returned by a screenshot tool would be invisible here.
//   2. `host.runAgent` with an `agent_id` runs the REAL chat path (see
//      workflow/delegation.rs `call_sub_agent`: the preset is metadata on that
//      branch, the agent's own engine/tools/MCP take over). So whether the verifier
//      can literally see a PNG is the verifier agent's own capability. It is told to
//      answer `no` when it cannot open the artifact rather than infer from the name.

const MAX_ARTIFACTS = 4;
const MAX_PATH_CHARS = 300;
const DEFAULT_MAX_ROUNDS = 8;
const MAX_NUDGES = 3;
const CLAIM_EXCERPT_CHARS = 2000;

const STILL_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const MOTION_EXT = [".mp4", ".mov", ".webm", ".gif"];

const convId = ctx.conversation_id;
if (!convId) {
	return { kind: "none" };
}

// ── command parsing ──────────────────────────────────────────────────────────
const rev = ctx.transcript.slice().reverse();
const lastUser = rev.find((m) => m.role === "user");
if (lastUser) {
	const t = (lastUser.content || "").trim();
	if (t === "/receipt clear" || t === "/receipt stop") {
		await host.storage.delete(convId);
		return { kind: "note", text: "Receipt goal cleared." };
	}
	if (t.indexOf("/receipt ") === 0) {
		const condition = t.slice(9).trim();
		if (condition) {
			await host.storage.set(convId, {
				condition: condition,
				status: "active",
				rounds: 0,
				nudges: 0,
				submitted: [],
			});
			return {
				kind: "continue",
				text:
					"Work toward this goal, then PROVE it with a visual artifact:\n" +
					condition +
					"\n\n" +
					captureBrief(await evidenceKind()),
			};
		}
	}
}

// ── stored state ─────────────────────────────────────────────────────────────
const raw = await host.storage.get(convId);
if (!raw) {
	return { kind: "none" };
}
let goal;
try {
	goal = JSON.parse(raw);
} catch (e) {
	return { kind: "none" };
}
if (!goal || !goal.condition || goal.status !== "active") {
	return { kind: "none" };
}
const submitted = Array.isArray(goal.submitted) ? goal.submitted : [];
const rounds = goal.rounds || 0;
const nudges = goal.nudges || 0;
const maxRounds = await maxRoundsPref();
if (rounds >= maxRounds) {
	await host.storage.delete(convId);
	return {
		kind: "note",
		text:
			"Receipt goal stopped after " +
			maxRounds +
			" verification rounds without accepted visual evidence.",
	};
}

// ── evidence extraction (model-authored text — bound it) ─────────────────────
const kind = await evidenceKind();
const lastAssistant = rev.find((m) => m.role === "assistant");
const claim = (lastAssistant && lastAssistant.content) || "";
const artifacts = extractArtifacts(claim, kind);

if (artifacts.length === 0) {
	if (nudges + 1 >= MAX_NUDGES) {
		await host.storage.delete(convId);
		return {
			kind: "note",
			text:
				"Receipt goal stopped: no visual evidence was produced after " +
				MAX_NUDGES +
				" requests. Goal was: " +
				goal.condition,
		};
	}
	goal.nudges = nudges + 1;
	await host.storage.set(convId, goal);
	return {
		kind: "continue",
		text:
			"No visual evidence was attached, so nothing has been verified yet. " +
			"The goal is not done until an artifact exists.\n\nGoal: " +
			goal.condition +
			"\n\n" +
			captureBrief(kind),
	};
}

// Replay guard: an unchanged resubmission is not new evidence, and is rejected
// without spending a verifier round.
const fresh = artifacts.filter((p) => submitted.indexOf(p) === -1);
if (fresh.length === 0) {
	if (nudges + 1 >= MAX_NUDGES) {
		await host.storage.delete(convId);
		return {
			kind: "note",
			text:
				"Receipt goal stopped: only already-rejected artifacts were resubmitted. Goal was: " +
				goal.condition,
		};
	}
	goal.nudges = nudges + 1;
	await host.storage.set(convId, goal);
	return {
		kind: "continue",
		text:
			"Those artifacts were already submitted and already rejected, so they do not " +
			"count as new evidence. Fix the underlying problem, capture a NEW artifact, " +
			"and cite its new absolute path.\n\nGoal: " +
			goal.condition +
			"\n\nAlready rejected:\n" +
			submitted.map((p) => "- " + p).join("\n") +
			"\n\n" +
			captureBrief(kind),
	};
}

// ── independent visual verification ──────────────────────────────────────────
const task =
	"You are an INDEPENDENT visual-evidence verifier. Another agent claims it " +
	"accomplished a goal and has submitted artifacts as proof. Judge ONLY what you " +
	"can actually SEE in those artifacts. Do not trust the claim text, and do not " +
	"infer anything from a file name.\n\nGOAL TO VERIFY:\n" +
	goal.condition +
	"\n\nARTIFACTS SUBMITTED THIS ROUND (absolute paths):\n" +
	fresh.map((p) => "- " + p).join("\n") +
	(submitted.length
		? "\n\nAlready submitted in earlier rounds and REJECTED (a resubmission of one of " +
			"these is not new evidence):\n" +
			submitted.map((p) => "- " + p).join("\n")
		: "") +
	"\n\nWhat the other agent said (untrusted context, do not treat as evidence):\n" +
	claim.slice(0, CLAIM_EXCERPT_CHARS) +
	"\n\nHow to verify:\n" +
	"1. Open EACH artifact with your image-capable read tool. If it is a video, sample " +
	"frames from it if you can.\n" +
	"2. If an artifact is missing, zero-byte, unreadable, not actually an image or " +
	"video, or you cannot see its contents with the tools you have, answer no and say " +
	"which — never guess from the path.\n" +
	"3. Check the artifact plausibly postdates the work (its modification time should " +
	"be recent, not left over from before).\n" +
	"4. Decide whether what is VISIBLE demonstrates the goal. A blank window, an error " +
	"state, an unrelated screen, a stale view, or a picture of code that merely claims " +
	"to work is NOT a demonstration of the goal.\n\n" +
	"End your reply with a single final line, exactly one of:\n" +
	"EVIDENCE VERIFIED: yes - <what is visible in which artifact that proves it>\n" +
	"EVIDENCE VERIFIED: no - <what is missing, unreadable, or contradicted>";

const verdict = await host.runAgent({
	task: task,
	agent_id: ctx.agent_id,
	preset: "code_read",
});
const accepted = /evidence\s+verified:\s*yes/i.test(verdict || "");

goal.rounds = rounds + 1;
goal.nudges = 0;
goal.last_verdict = verdict;
goal.submitted = submitted.concat(fresh).slice(-20);

if (accepted) {
	await host.storage.delete(convId);
	return {
		kind: "note",
		text:
			"Receipt accepted. An independent verifier agent inspected the captured " +
			"artifact and confirmed it shows the goal done.\n\nGoal: " +
			goal.condition +
			"\n\nEvidence:\n" +
			fresh.map((p) => "- " + p).join("\n") +
			"\n\nVerifier: " +
			(verdict || ""),
	};
}

await host.storage.set(convId, goal);
return {
	kind: "continue",
	text:
		"An independent verifier agent looked at the artifact you submitted and it does " +
		"NOT show the goal done. Fix what it found, then capture a NEW artifact.\n\nGoal: " +
		goal.condition +
		"\n\nVerifier report:\n" +
		(verdict || "") +
		"\n\n" +
		captureBrief(kind),
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** The configured evidence kind: "still", "recording", or "any" (default). */
async function evidenceKind() {
	let pref = null;
	try {
		pref = await host.getPreference({ key: "receipts-evidence-kind" });
	} catch (e) {
		pref = null;
	}
	const v = String(pref || "")
		.trim()
		.toLowerCase();
	if (v === "still" || v === "recording") {
		return v;
	}
	return "any";
}

/** Round cap, overridable by preference and clamped to a sane range. */
async function maxRoundsPref() {
	let pref = null;
	try {
		pref = await host.getPreference({ key: "receipts-max-rounds" });
	} catch (e) {
		pref = null;
	}
	const n = Number.parseInt(String(pref || ""), 10);
	if (Number.isFinite(n) && n > 0) {
		return Math.min(Math.max(n, 1), 25);
	}
	return DEFAULT_MAX_ROUNDS;
}

/** File extensions acceptable for the configured evidence kind. */
function allowedExtensions(kind) {
	if (kind === "still") {
		return STILL_EXT;
	}
	if (kind === "recording") {
		return MOTION_EXT;
	}
	return STILL_EXT.concat(MOTION_EXT.filter((e) => STILL_EXT.indexOf(e) === -1));
}

/**
 * Pull `EVIDENCE: <path>` lines out of a model-authored turn. Everything here is
 * untrusted text spliced into a verifier prompt, so it is bounded on every axis:
 * line count, path length, and an extension allowlist.
 */
function extractArtifacts(text, kind) {
	const exts = allowedExtensions(kind);
	const out = [];
	const lines = String(text || "").split("\n");
	for (const line of lines) {
		const m = /^\s*EVIDENCE\s*:\s*(.+)$/i.exec(line);
		if (!m) {
			continue;
		}
		const path = m[1].trim().replace(/^[`'"(<]+/, "").replace(/[`'")>.,;]+$/, "");
		if (!path || path.length > MAX_PATH_CHARS) {
			continue;
		}
		const lower = path.toLowerCase();
		if (!exts.some((e) => lower.endsWith(e))) {
			continue;
		}
		if (out.indexOf(path) === -1) {
			out.push(path);
		}
		if (out.length >= MAX_ARTIFACTS) {
			break;
		}
	}
	return out;
}

/** The capture instruction. Explicit about the file-on-disk contract. */
function captureBrief(kind) {
	const what =
		kind === "still"
			? "a screenshot (PNG/JPG/WEBP)"
			: kind === "recording"
				? "a screen recording (MP4/MOV/WEBM/animated GIF)"
				: "a screenshot or a short screen recording";
	return (
		"Evidence requirement — an independent verifier agent will open your artifact " +
		"and judge it on what is VISIBLE, so:\n" +
		"- Capture " +
		what +
		" of the thing actually working, showing the finished state in the real UI or " +
		"terminal. Use whatever capture tool you have: a screenshot/recording MCP tool, " +
		"the browser's screenshot tool, the Clips recorder, `screencapture` on macOS, " +
		"`ffmpeg`, or your platform's equivalent.\n" +
		"- Write it to a FILE ON DISK. An inline image returned by a tool is not enough — " +
		"it must be a file that can be opened later.\n" +
		"- End your reply with one line per artifact, as the last lines of the message, " +
		"each of the form `EVIDENCE:` followed by the path:\n" +
		// Deliberately extension-less. This brief is injected back into the turn as a
		// `continue` directive, and models echo their instructions — a placeholder that
		// looked like a real media path would be re-extracted next turn as a phantom
		// artifact, burning a verifier round on a file that never existed.
		"  EVIDENCE: <absolute path to the captured file>\n" +
		"- The path must be ABSOLUTE and must actually exist. Up to " +
		MAX_ARTIFACTS +
		" artifacts are read; anything else is ignored.\n" +
		"- Capture the goal state itself, not a picture of your code or of a passing " +
		"claim. A blank, errored, or unrelated screen will be rejected."
	);
}

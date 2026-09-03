// Turn-hook body for `no-more-mistakes.command`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.spaces / host.storage / host.getPreference / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.
//
// `/mistakes` — read and edit the ledger from the chat. Every branch returns
// `handled`, so the command never reaches the main model: listing rules the plugin
// already holds, or writing one the user just dictated, is bookkeeping, and paying a
// frontier-model turn for it would be absurd.
//
//   /mistakes              the rules, numbered
//   /mistakes add <rule>   write one by hand
//   /mistakes forget <n>   drop the rule with that number
//   /mistakes off | on     stop / resume automatic learning in THIS chat

const DEFAULT_SPACE_NAME = "Mistakes";
const MAX_RULE_CHARS = 160;
const MAX_LISTED = 100;

const convId = ctx.conversation_id;
const input = String(ctx.input || "").trim();

// The Rust pre-gate (`match.commands`) is a prefix test, so it also lets
// `/mistakesomething` through. Require the whole word: claiming a turn the user did
// not address to this plugin would answer a different command with a rule list.
if (input !== "/mistakes" && input.indexOf("/mistakes ") !== 0) {
	return { kind: "none" };
}

const rest = input.slice("/mistakes".length).trim();
const word = rest.split(/\s+/)[0].toLowerCase();
const argument = rest.slice(word.length).trim();

// ── the mute switches ────────────────────────────────────────────────────────
// Per-conversation, not global: "stop reading over my shoulder in this chat" and
// "stop learning at all" are different asks, and the second one is the setting.
if (word === "off" || word === "mute" || word === "stop") {
	await setMuted(true);
	return {
		kind: "handled",
		text: "Not learning from corrections in this chat any more. The existing rules still apply — `/mistakes on` resumes, and `/mistakes add` still works.",
	};
}
if (word === "on" || word === "unmute" || word === "start") {
	await setMuted(false);
	return {
		kind: "handled",
		text: "Learning from corrections again in this chat.",
	};
}

const spaceName = (await pref("mistakes-space")) || DEFAULT_SPACE_NAME;

let spaceId = null;
try {
	spaceId = await host.spaces.ensureSpace({
		name: spaceName,
		description:
			"Rules learned from corrections, by the No More Mistakes plugin. Editing or deleting a document here changes what agents are told.",
	});
} catch (e) {
	host.log("no-more-mistakes: opening the ledger failed", e);
	return {
		kind: "handled",
		text: "Couldn't open the " + spaceName + " Space, so there is nothing to show. The rules are unchanged.",
	};
}

// ── add ──────────────────────────────────────────────────────────────────────
if (word === "add" || word === "remember") {
	const rule = oneLine(argument).slice(0, MAX_RULE_CHARS);
	if (!rule) {
		return {
			kind: "handled",
			text: "Give me the rule to remember, e.g. `/mistakes add Never edit files under vendor/ — they are generated`.",
		};
	}
	const existing = await listRules(spaceId);
	if (existing.some((r) => sameRule(r.title, rule))) {
		return { kind: "handled", text: "Already on the list: " + rule };
	}
	try {
		const docId = await host.spaces.createDoc({ space_id: spaceId, title: rule });
		await host.spaces.updateDoc({
			doc_id: docId,
			title: rule,
			source:
				"# " +
				rule +
				"\n\n**Why:** Added by hand with `/mistakes add`.\n\n**Recorded:** " +
				new Date().toISOString() +
				(convId ? "\n\n**Conversation:** " + convId : "") +
				"\n",
		});
	} catch (e) {
		host.log("no-more-mistakes: writing the rule failed", e);
		return {
			kind: "handled",
			text: "Couldn't write that rule to the " + spaceName + " Space. Nothing was recorded — try again.",
		};
	}
	return {
		kind: "handled",
		text: "Recorded. Every new chat starts with this one now:\n\n" + rule,
	};
}

// ── forget ───────────────────────────────────────────────────────────────────
if (word === "forget" || word === "remove" || word === "delete") {
	const rules = await listRules(spaceId);
	if (rules.length === 0) {
		return { kind: "handled", text: "Nothing recorded yet, so there is nothing to forget." };
	}
	const index = Number.parseInt(argument, 10);
	// By number only, deliberately: a substring match would let "forget git" drop a
	// rule the user meant to keep, and the numbers are right there in the listing.
	if (!Number.isFinite(index) || index < 1 || index > rules.length) {
		return {
			kind: "handled",
			text:
				"Which one? Give me its number from `/mistakes` — 1 to " +
				rules.length +
				".",
		};
	}
	const target = rules[index - 1];
	try {
		await host.spaces.deleteDoc({ doc_id: target.id });
	} catch (e) {
		host.log("no-more-mistakes: deleting the rule failed", e);
		return {
			kind: "handled",
			text: "Couldn't delete that rule. It is still on the list.",
		};
	}
	return { kind: "handled", text: "Forgotten: " + target.title };
}

// ── list (the bare command, and anything unrecognized) ───────────────────────
const rules = await listRules(spaceId);
if (rules.length === 0) {
	return {
		kind: "handled",
		text:
			"No rules yet. I add one whenever you correct me — or write one now with " +
			"`/mistakes add <rule>`. They live in the " +
			spaceName +
			" Space, one document each, and every new chat starts with them.",
	};
}

const listed = rules
	.slice(0, MAX_LISTED)
	.map((r, i) => String(i + 1) + ". " + r.title)
	.join("\n");

return {
	kind: "handled",
	text:
		"Standing rules from past corrections (" +
		spaceName +
		" Space). Every new chat starts with these:\n\n" +
		listed +
		"\n\n`/mistakes add <rule>` records one, `/mistakes forget <number>` drops one, `/mistakes off` stops learning in this chat.",
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** One preference as a trimmed string, or `""` on any failure. */
async function pref(key) {
	try {
		const v = await host.getPreference({ key: key });
		return v == null ? "" : String(v).trim();
	} catch (e) {
		return "";
	}
}

/** The ledger as `[{id, title}]`, newest first, empty on any failure. */
async function listRules(spaceId) {
	try {
		const docs = (await host.spaces.listDocs({ space_id: spaceId })) || [];
		return docs
			.map((d) => ({ id: String(d.id || ""), title: String(d.title || "").trim() }))
			.filter((d) => d.id && d.title);
	} catch (e) {
		host.log("no-more-mistakes: listing the ledger failed", e);
		return [];
	}
}

/** Set (or clear) the per-conversation mute the capture hook reads. */
async function setMuted(muted) {
	if (!convId) {
		return;
	}
	try {
		await host.storage.set(convId, { muted: muted });
	} catch (e) {
		host.log("no-more-mistakes: storing the mute failed", e);
	}
}

/** Collapse whitespace and drop a trailing period, so a rule is one clean line. */
function oneLine(value) {
	return String(value == null ? "" : value)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.$/, "");
}

/** Case- and punctuation-insensitive equality, so `add` cannot re-file a rule. */
function sameRule(a, b) {
	const norm = (s) =>
		String(s)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
	return norm(a) === norm(b);
}

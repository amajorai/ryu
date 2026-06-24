// @ryu/protocol — the canonical agent system-prompt "rules" format.
//
// An agent has a single stored `systemPrompt`, but editors present "Instructions"
// (free-form markdown) and "Rules" (a +/- list of one-liners) as separate UI
// sections. These pure helpers fold the rules into the prompt on save and split
// them back out on load, so rules genuinely become part of the prompt (honored on
// every route — ACP and openai-compat alike) while staying editable as a list.
// The rules live in a fenced block delimited by HTML comment markers so the
// round-trip is unambiguous even if the user writes their own "## Rules" heading.
//
// This is a wire-format CONTRACT: any surface that edits an agent's system prompt
// must preserve the same block, so it lives here (shared) rather than in one app —
// the desktop used to be its sole owner.

const RULES_START = "<!--ryu:rules-->";
const RULES_END = "<!--/ryu:rules-->";
const RULES_HEADING = "## Rules";

/**
 * Compose the stored system prompt from the instructions markdown and the rules
 * list. Empty rules collapse to just the instructions (no block emitted).
 */
export function composeRules(instructions: string, rules: string[]): string {
	const body = instructions.trim();
	const clean = rules.map((r) => r.trim()).filter((r) => r.length > 0);
	if (clean.length === 0) {
		return body;
	}
	const bullets = clean.map((r) => `- ${r}`).join("\n");
	const block = `${RULES_HEADING}\n${RULES_START}\n${bullets}\n${RULES_END}`;
	return body ? `${body}\n\n${block}` : block;
}

/**
 * Split a stored system prompt back into instructions + rules. When no rules
 * block is present, the whole prompt is the instructions and rules is empty.
 */
export function parseRules(systemPrompt: string): {
	instructions: string;
	rules: string[];
} {
	const text = systemPrompt ?? "";
	const start = text.indexOf(RULES_START);
	const end = text.indexOf(RULES_END);
	if (start === -1 || end === -1 || end < start) {
		return { instructions: text.trim(), rules: [] };
	}
	const inner = text.slice(start + RULES_START.length, end);
	const rules = inner
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => (l.startsWith("- ") ? l.slice(2) : l).trim())
		.filter((l) => l.length > 0);
	let instructions = text.slice(0, start).trimEnd();
	if (instructions.endsWith(RULES_HEADING)) {
		instructions = instructions.slice(0, -RULES_HEADING.length).trimEnd();
	}
	return { instructions: instructions.trim(), rules };
}

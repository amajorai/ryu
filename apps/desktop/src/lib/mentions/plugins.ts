// The composer-plugin registry — the "anyone can build" extensibility surface
// for the "@" menu. Built-ins ship with Ryu and reuse existing command
// semantics (see docs/rfc-mention-composer.md, "reuse existing commands"):
//   goal / btw    → rewrite the composer to their real slash command.
//   double-check  → insert a canned self-verify instruction (works, no backend).
//   proof         → insert a canned "justify step by step" instruction.
// Third-party plugins will register through the same list once the plugin
// runtime lands (docs/rfc-plugin-runtime.md).

import {
	IconMessageCircleQuestion,
	IconShieldCheck,
	IconSparkles,
	IconTarget,
} from "@tabler/icons-react";
import type { ComposerPlugin } from "./types.ts";

const DOUBLE_CHECK_PROMPT =
	"Double-check your previous answer. Re-verify each claim, flag anything uncertain, and correct any mistakes.";

const PROOF_PROMPT =
	"Prove your answer is correct: walk through your reasoning step by step and justify each step.";

/** Ryu's built-in composer plugins, offered in the "@" menu under "Plugins". */
export const BUILTIN_COMPOSER_PLUGINS: ComposerPlugin[] = [
	{
		id: "goal",
		name: "Goal",
		description: "Set a goal the agent works toward each turn",
		icon: IconTarget,
		builtin: true,
		action: { type: "slash", name: "goal" },
	},
	{
		id: "btw",
		name: "Side question",
		description: "Ask a quick side question without derailing the chat",
		icon: IconMessageCircleQuestion,
		builtin: true,
		action: { type: "slash", name: "btw" },
	},
	{
		id: "double-check",
		name: "Double-check",
		description: "Have the agent re-verify and correct its last answer",
		icon: IconShieldCheck,
		builtin: true,
		action: { type: "prompt", text: DOUBLE_CHECK_PROMPT },
	},
	{
		id: "proof",
		name: "Proof",
		description: "Ask the agent to justify its answer step by step",
		icon: IconSparkles,
		builtin: true,
		action: { type: "prompt", text: PROOF_PROMPT },
	},
];

/**
 * The active set of composer plugins. Today this is just the built-ins; it's a
 * function (not a const) so the future third-party registry is a drop-in swap
 * without touching call sites.
 */
export function getComposerPlugins(): ComposerPlugin[] {
	return BUILTIN_COMPOSER_PLUGINS;
}

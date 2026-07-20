import {
	AiBrain01Icon,
	Alert02Icon,
	PencilEdit02Icon,
	Task01Icon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import type {
	ComposerSettingItem,
	ItemDecoration,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";

/**
 * Claude-Code-CLI-style colour + icon for a permission (approval) mode, keyed on
 * the mode's advertised id/name — NOT on any specific agent, so Codex's
 * `Auto`/`Full Access`, Claude's `acceptEdits`/`plan`/`bypassPermissions`, and any
 * other agent's equivalent modes all light up the same way. Nothing is hardcoded
 * per agent: we classify by the semantic keyword the mode reports, and modes we
 * don't recognise (e.g. the neutral "ask every time" default) simply render plain.
 */
const PLAN = {
	icon: Task01Icon,
	className: "text-emerald-600 dark:text-emerald-400",
} as const;
const ACCEPT_EDITS = {
	icon: PencilEdit02Icon,
	className: "text-purple-600 dark:text-purple-400",
} as const;
const BYPASS = {
	icon: Alert02Icon,
	className: "text-red-600 dark:text-red-400",
} as const;
const AUTO = {
	icon: AiBrain01Icon,
	className: "text-amber-600 dark:text-amber-400",
} as const;
const READ_ONLY = {
	icon: ViewIcon,
	className: "text-sky-600 dark:text-sky-400",
} as const;

/**
 * Map one advertised approval-mode item to its CLI-style tone, or `undefined`
 * for an unrecognised/neutral mode (rendered without colour or icon).
 */
export function approvalModeStyle(
	item: ComposerSettingItem
): ItemDecoration | undefined {
	const hay = `${item.id} ${item.name}`.toLowerCase();

	// Order matters: check the more specific/dangerous keywords first so a mode
	// named e.g. "Full Access (bypass)" resolves to the red tone, not "accept".
	if (
		hay.includes("bypass") ||
		hay.includes("full access") ||
		hay.includes("full-access") ||
		hay.includes("fullaccess") ||
		hay.includes("danger") ||
		hay.includes("yolo") ||
		hay.includes("skip")
	) {
		return BYPASS;
	}
	if (hay.includes("plan")) {
		return PLAN;
	}
	if (hay.includes("accept") || hay.includes("auto-accept")) {
		return ACCEPT_EDITS;
	}
	if (hay.includes("auto")) {
		return AUTO;
	}
	if (hay.includes("read")) {
		return READ_ONLY;
	}
	return;
}

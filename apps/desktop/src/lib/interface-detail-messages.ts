// Interface activity labels as whole messages (`interface-detail.ts`): one
// catalog sentence per step kind, with and without the thing it acts on, so a
// translation never glues a verb fragment to a target ("Asking {target}",
// not "Asking" + " " + target).

import { translate as tl } from "@ryu/i18n/core";
import type { InterfaceActivityKind } from "@ryuhq/protocol/interfaces";

interface KindMessages {
	/** The label when the step names nothing it acts on. */
	readonly bare: () => string;
	/** The English verb, only to spot a tool whose name repeats it ("Edit"). */
	readonly verb: string;
	/** The label naming what the step acts on: a file, command, host or tool. */
	readonly withTarget: (target: string) => string;
}

const KIND_MESSAGES: Record<InterfaceActivityKind, KindMessages> = {
	answer: {
		bare: () => tl("Writing the answer"),
		verb: "Writing",
		withTarget: (target) => tl("Writing {target}", { target }),
	},
	ask: {
		bare: () => tl("Asking a question"),
		verb: "Asking",
		withTarget: (target) => tl("Asking {target}", { target }),
	},
	delegate: {
		bare: () => tl("Delegating"),
		verb: "Delegating",
		withTarget: (target) => tl("Delegating {target}", { target }),
	},
	edit: {
		bare: () => tl("Editing"),
		verb: "Editing",
		withTarget: (target) => tl("Editing {target}", { target }),
	},
	plan: {
		bare: () => tl("Planning"),
		verb: "Planning",
		withTarget: (target) => tl("Planning {target}", { target }),
	},
	read: {
		bare: () => tl("Reading"),
		verb: "Reading",
		withTarget: (target) => tl("Reading {target}", { target }),
	},
	run: {
		bare: () => tl("Running"),
		verb: "Running",
		withTarget: (target) => tl("Running {target}", { target }),
	},
	search: {
		bare: () => tl("Searching"),
		verb: "Searching",
		withTarget: (target) => tl("Searching {target}", { target }),
	},
	think: {
		bare: () => tl("Thinking"),
		verb: "Thinking",
		withTarget: (target) => tl("Thinking about {target}", { target }),
	},
	tool: {
		bare: () => tl("Using a tool"),
		verb: "Using",
		withTarget: (target) => tl("Using {target}", { target }),
	},
	web: {
		bare: () => tl("Fetching"),
		verb: "Fetching",
		withTarget: (target) => tl("Fetching {target}", { target }),
	},
	write: {
		bare: () => tl("Writing"),
		verb: "Writing",
		withTarget: (target) => tl("Writing {target}", { target }),
	},
};

/**
 * The activity label of a step kind in the shown language: "Editing
 * snapshot.ts" when `target` names what it acts on, else the kind's
 * standalone form ("Thinking", "Writing the answer"). Unclamped; callers
 * clamp the translated text.
 */
export function activityMessage(
	kind: InterfaceActivityKind,
	target?: string | null
): string {
	const messages = KIND_MESSAGES[kind];
	const named = target?.trim();
	return named ? messages.withTarget(named) : messages.bare();
}

/**
 * Whether a tool's English display name only repeats the kind's verb
 * ("Edit" for editing), so the label should be the standalone form rather
 * than "Editing Edit".
 */
export function toolRepeatsKindVerb(
	kind: InterfaceActivityKind,
	display: string
): boolean {
	const stem = display.toLowerCase().replace(/e$/, "");
	return (
		stem.length > 0 && KIND_MESSAGES[kind].verb.toLowerCase().startsWith(stem)
	);
}

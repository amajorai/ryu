// packages/marketplace/src/catalog/detail/api-reference-labels.ts
//
// Translated names for the manifest tokens the API-reference tab shows: the hook
// phase a turn hook fires on, the type of a composer control and the surface a
// view targets. The tab used to splice the raw token into a translated sentence
// ("before turn に実行"), leaving English inside every other language.
//
// Each known token maps to a WHOLE translated phrase, written as a literal
// `tl(...)` call so the extractor sees it. An unknown token returns `null`: the
// vocabularies are open on purpose (a newer manifest may declare a phase this
// build has never heard of), and the panel then shows a generic translated label
// beside the raw token in a code chip instead of guessing a translation.

import { translate as tl } from "@ryu/i18n/lite";
import { SURFACE_LABELS } from "../surface-labels.ts";

type LabelTable = Readonly<Record<string, () => string>>;

/** The sentence a turn hook row reads as, per hook phase (`on`/`event`). Mirrors
 *  the phase constants in Core's `plugin_host/phases.rs`. */
const HOOK_EVENT_LABELS: LabelTable = {
	action: () => tl("Runs on every thinking step and tool call"),
	context: () => tl("Runs before the context is sent to the model"),
	delegation_lifecycle: () => tl("Runs when a delegated agent starts or ends"),
	message_end: () => tl("Runs when every assistant message is finalized"),
	model_select: () => tl("Runs when the model or thinking level changes"),
	notification: () => tl("Runs on every notification"),
	plugin_update: () => tl("Runs after the plugin is updated"),
	post_assistant_turn: () => tl("Runs after every assistant reply"),
	post_tool_use: () => tl("Runs after every tool call"),
	pre_model_select: () => tl("Runs before the model is chosen for a turn"),
	pre_tool_use: () => tl("Runs before every tool call"),
	pre_user_turn: () => tl("Runs before every message is sent"),
	session_before_compact: () => tl("Runs before older messages are compacted"),
	session_compact: () => tl("Runs after older messages are summarized"),
	session_end: () => tl("Runs when a conversation is deleted"),
	session_start: () => tl("Runs when a conversation starts"),
	session_tree: () => tl("Runs when a conversation branches"),
	stop: () => tl("Runs after every assistant reply"),
	subagent_stop: () => tl("Runs when a sub-agent finishes"),
	tool_result: () => tl("Runs on every tool result before the model sees it"),
	view_action: () => tl("Runs when you use one of its view actions"),
	workflow_run_failed: () => tl("Runs when a workflow run fails"),
	workflow_run_finished: () => tl("Runs when a workflow run finishes"),
	workflow_run_started: () => tl("Runs when a workflow run starts"),
};

/** The badge for a composer control, per control `type`. The vocabulary is the
 *  one `Contributes::composer_controls` documents in the manifest contract. */
const COMPOSER_CONTROL_LABELS: LabelTable = {
	action: () => tl("Composer button"),
	chip: () => tl("Composer chip"),
	select: () => tl("Composer picker"),
	toggle: () => tl("Composer switch"),
};

/** Workbench regions a view may name, beyond the host surfaces. */
const VIEW_REGION_LABELS: LabelTable = {
	dialog: () => tl("Dialog view"),
	page: () => tl("Page view"),
	panel: () => tl("Panel view"),
	sidebar: () => tl("Sidebar view"),
};

function lookup(table: LabelTable, token: string | null | undefined) {
	const key = token?.trim().toLowerCase();
	if (!key) {
		return null;
	}
	return Object.hasOwn(table, key) ? (table[key]?.() ?? null) : null;
}

/** The translated sentence for a turn hook's phase, or `null` when unknown. */
export function hookEventLabel(event: string | null | undefined) {
	return lookup(HOOK_EVENT_LABELS, event);
}

/** The generic sentence shown beside an unlabelled hook token in a code chip.
 *  `<plugin>#<event>` is an app event another plugin emits, an identifier with no
 *  translation of its own. */
export function hookEventFallbackLabel(event: string): string {
	return event.includes("#")
		? tl("Runs when another app emits an event")
		: tl("Runs on a hook event");
}

/** The translated badge for a composer control type, or `null` when unknown. */
export function composerControlLabel(type: string | null | undefined) {
	return lookup(COMPOSER_CONTROL_LABELS, type);
}

/** The translated badge for a view's target, or `null` when unknown. A host
 *  surface (desktop, web, ...) reuses the store's surface names. */
export function viewSurfaceLabel(surface: string | null | undefined) {
	const region = lookup(VIEW_REGION_LABELS, surface);
	if (region) {
		return region;
	}
	const key = surface?.trim().toLowerCase();
	if (!(key && Object.hasOwn(SURFACE_LABELS, key)) || key === "unknown") {
		return null;
	}
	return tl("{surface} view", { surface: tl(SURFACE_LABELS[key] ?? key) });
}

/** The known tokens per vocabulary, for tests and tooling. */
export const API_REFERENCE_TOKENS = {
	composerControlTypes: Object.keys(COMPOSER_CONTROL_LABELS),
	hookEvents: Object.keys(HOOK_EVENT_LABELS),
	viewRegions: Object.keys(VIEW_REGION_LABELS),
} as const;

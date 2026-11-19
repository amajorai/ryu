// A timeline entry's kind badge and title as the viewer reads them. The kind
// is a raw enum (`call`, `note`, …) and the merge entry's title is the
// backend's fixed English "Merged N record(s) into this one", stored on the
// activity; both are shown translated here, with the merge count pluralized.
// An entry saved with neither title nor body is stored as the backend's
// "Untitled <kind>" (`activity_title` in crm/backend/src/api/insights.rs), which
// is translated as one whole sentence per authored kind.

import { translateMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { ActivityKind } from "@/src/lib/api/crm.ts";

/** Authored kinds; audit kinds render as a sentence, never a badge. */
export type AuthoredActivityKind = Exclude<
	ActivityKind,
	"field_change" | "stage_change"
>;

export function activityKindLabel(
	kind: AuthoredActivityKind,
	tl: LiteralMessage
): string {
	switch (kind) {
		case "call":
			return tl("Call");
		case "meeting":
			return tl("Meeting");
		case "task":
			return tl("Task");
		default:
			return activityNoteLabel();
	}
}

/**
 * The note kind, read through the keyed `crm.activityNote`: the bare catalog
 * "Note" is also an annotation (zh-CN "批注"), not a CRM note.
 */
export function activityNoteLabel(): string {
	return translateMessage("crm.activityNote", {}, "Note");
}

const MERGE_TITLE = /^Merged (\d+) records? ?(?:\(s\))? into this one$/u;

const UNTITLED: Readonly<Record<string, (tl: LiteralMessage) => string>> = {
	"Untitled call": (tl) => tl("Untitled call"),
	"Untitled meeting": (tl) => tl("Untitled meeting"),
	"Untitled note": (tl) => tl("Untitled note"),
	"Untitled task": (tl) => tl("Untitled task"),
};

/** The entry title, with the backend's merge and untitled sentences translated. */
export function activityTitle(title: string, tl: LiteralMessage): string {
	const untitled = UNTITLED[title.trim()];
	if (untitled) {
		return untitled(tl);
	}
	const match = MERGE_TITLE.exec(title.trim());
	if (!match) {
		return title;
	}
	return tl(
		"{count, plural, one {Merged # record into this one} other {Merged # records into this one}}",
		{ count: Number(match[1]) }
	);
}

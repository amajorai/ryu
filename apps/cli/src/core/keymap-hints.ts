// Inline key-hint lines ("↑↓ move · Enter open · r refresh"). Each segment is
// translated as one whole "{keys} {label}" phrase before the segments are
// joined, so a translator sees "Esc back" (not a bare "back" that collides with
// other senses) and the joined line never has to match a catalog key itself.

import { tr } from "../i18n/translate.ts";

/** The fields a hint segment reads (a subset of `KeyHint` in keymap.ts). */
export interface HintSegmentSource {
	keys: string;
	label: string;
}

/**
 * Every segment the CLI's hint lines build, spelled out as literals so the
 * catalog extractor keeps each key. A segment missing here still goes through
 * `tr`, so a catalog entry added elsewhere is honored.
 */
const HINT_SEGMENT_COPY: Readonly<Record<string, () => string>> = {
	"/ search": () => tr("/ search"),
	"0 none": () => tr("0 none"),
	"a add key": () => tr("a add key"),
	"c no limit": () => tr("c no limit"),
	"e edit": () => tr("e edit"),
	"Enter add key": () => tr("Enter add key"),
	"Enter apply": () => tr("Enter apply"),
	"Enter choose": () => tr("Enter choose"),
	"Enter continue": () => tr("Enter continue"),
	"Enter detail": () => tr("Enter detail"),
	"Enter open": () => tr("Enter open"),
	"Enter open realm": () => tr("Enter open realm"),
	"Enter submit": () => tr("Enter submit"),
	"Enter/a act": () => tr("Enter/a act"),
	"Esc back": () => tr("Esc back"),
	"Esc cancel": () => tr("Esc cancel"),
	"Esc interrupt": () => tr("Esc interrupt"),
	"Esc skip": () => tr("Esc skip"),
	"n new": () => tr("n new"),
	"r refresh": () => tr("r refresh"),
	"r reset": () => tr("r reset"),
	"r retry": () => tr("r retry"),
	"Space allow/deny": () => tr("Space allow/deny"),
	"Space/Enter toggle": () => tr("Space/Enter toggle"),
	"Tab/Enter choose": () => tr("Tab/Enter choose"),
	"←/→ or 1-3 choose": () => tr("←/→ or 1-3 choose"),
	"←→ sections": () => tr("←→ sections"),
	"↑↓ move": () => tr("↑↓ move"),
};

/** One hint segment in the reader's language ("Esc back" → "Esc zurück"). */
export function hintSegment(hint: HintSegmentSource): string {
	const segment = `${hint.keys} ${hint.label}`;
	return Object.hasOwn(HINT_SEGMENT_COPY, segment)
		? HINT_SEGMENT_COPY[segment]()
		: tr(segment);
}

/** Translate each hint segment, then join them into one inline hint line. */
export function joinHintSegments(hints: readonly HintSegmentSource[]): string {
	return hints.map(hintSegment).join(" · ");
}

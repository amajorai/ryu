// The queue bar's and queue overlay's hint lines. Each part is a whole
// catalogued phrase ("x remove", "Esc cancel"), translated on its own before
// the parts are joined, because the joined line never matches a catalog key.

import { tr } from "../i18n/translate.ts";

/** The parts shared by the focused queue bar and the queue overlay. */
export interface QueueHintParts {
	cancelHint: string;
	clearHint?: string | null;
	onClear?: unknown;
	onMove?: unknown;
	onRemove?: unknown;
}

/** Translate each present hint part, then join them with " · ". */
export function joinQueueHints(
	parts: readonly (string | null | undefined)[]
): string {
	return parts
		.filter((part): part is string => Boolean(part))
		.map((part) => tr(part))
		.join(" · ");
}

/** "↑↓ move · ⇧↑↓ reorder · x remove · c clear · Esc cancel", per handler. */
export function queueActionHints({
	cancelHint,
	clearHint,
	onClear,
	onMove,
	onRemove,
}: QueueHintParts): string {
	return joinQueueHints([
		tr("↑↓ move"),
		onMove ? tr("⇧↑↓ reorder") : null,
		onRemove ? tr("x remove") : null,
		onClear ? clearHint : null,
		cancelHint,
	]);
}

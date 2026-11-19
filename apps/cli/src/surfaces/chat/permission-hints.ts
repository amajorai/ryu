// The permission prompt's key-hint line. Each segment is one whole catalogued
// phrase translated before the segments are joined, so the joined line never
// has to match a catalog key itself.

import { tf, tr } from "../../i18n/translate.ts";

export interface PermissionHintOptions {
	/** How many options the prompt offers (number keys 1..count). */
	count: number;
	/** Whether the detail body is taller than its slot and scrolls. */
	scrollable: boolean;
	unicode: boolean;
}

/** "1-3 select · ←/→ move · Enter confirm · Esc reject" in the reader's language. */
export function permissionHintLine({
	count,
	scrollable,
	unicode,
}: PermissionHintOptions): string {
	const dot = unicode ? "·" : "-";
	const arrows = unicode ? "←/→" : "left/right";
	const segments = [
		count > 1 ? tf("1-{count} select", { count }) : tr("1 select"),
		tf("{arrows} move", { arrows }),
		tr("Enter confirm"),
		tr("Esc reject"),
	];
	if (scrollable) {
		segments.push(tr("PgUp/PgDn scroll"));
	}
	return segments.join(` ${dot} `);
}

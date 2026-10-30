import type { LiteralMessage } from "@ryu/i18n/react";
import { plural, type TankSummary } from "./aquarium-model.ts";

/**
 * Escape inside a text field belongs to the field, except in the panel's own
 * composer while it is empty: there it closes the panel, as the Esc hint says.
 */
export function escapeIsFree(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return true;
	}
	const editable =
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !==
			null;
	if (!editable) {
		return true;
	}
	return (
		target instanceof HTMLTextAreaElement &&
		target.closest("[data-aquarium-composer]") !== null &&
		target.value.trim() === ""
	);
}

export interface SummaryPart {
	/** Kept in the narrowest header, where only the live counts fit. */
	essential: boolean;
	text: string;
}

export function summaryParts(
	summary: TankSummary,
	tl: LiteralMessage
): SummaryPart[] {
	if (summary.agents === 0) {
		return [{ essential: true, text: "No agents yet" }];
	}
	const parts: SummaryPart[] = [
		{ essential: false, text: plural(summary.agents, "agent") },
		{ essential: true, text: `${summary.working} working` },
	];
	if (summary.attention > 0) {
		parts.push({
			essential: true,
			text: tl(
				"{count, plural, one {{attention} needs attention} other {{attention} need attention}}",
				{ attention: String(summary.attention), count: summary.attention }
			),
		});
	}
	if (summary.yourTurn > 0) {
		parts.push({
			essential: false,
			text: tl("{yourTurn} waiting on you", {
				yourTurn: String(summary.yourTurn),
			}),
		});
	}
	return parts;
}

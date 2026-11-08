// Prompt Studio assertion chip labels. The chips show the Gateway's snake_case
// wire tag; this maps it to the same translated label the assertion editor
// lists, so a chip reads "Enthält" in German rather than "contains".

import type { LiteralMessage } from "@ryu/i18n/react";
import { ASSERTION_LABELS } from "@/src/lib/prompt-studio.ts";

function isLabelledKind(kind: string): kind is keyof typeof ASSERTION_LABELS {
	return Object.hasOwn(ASSERTION_LABELS, kind);
}

/**
 * The translated label for an assertion kind. An unknown tag (a kind a newer
 * Gateway added) passes through raw so the chip still names the check.
 */
export function assertionLabel(kind: string, tl: LiteralMessage): string {
	return isLabelledKind(kind) ? tl(ASSERTION_LABELS[kind]) : kind;
}

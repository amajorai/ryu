// The /help overlay's lines. Each command's description is a catalogued
// phrase ("choose an agent"), translated on its own before it is placed after
// the usage, so the composed line never has to match a catalog key itself.

import type { CommandHelpRow } from "../../core/commands.ts";
import { tr } from "../../i18n/translate.ts";

/** "/agent   choose an agent" in the reader's language, usage left verbatim. */
export function helpOverlayLines(
	rows: readonly Pick<CommandHelpRow, "description" | "usage">[]
): string[] {
	const width = Math.max(0, ...rows.map((row) => row.usage.length));
	return rows.map(
		(row) => `${row.usage.padEnd(width)}  ${tr(row.description)}`
	);
}

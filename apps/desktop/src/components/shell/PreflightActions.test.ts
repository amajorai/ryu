import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { actionFailedTitle } from "./PreflightActions.tsx";

test("a failed action's toast names the action in the reader's language", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	expect(actionFailedTitle("Report issue", tl)).toBe(
		'[{label} failed]{"label":"[Report issue]"}'
	);
});

import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { parserFailureMessage } from "./documents.ts";

test("client-side parse failures are catalogued sentences", () => {
	const tl: LiteralMessage = (source) => `[${source}]`;
	expect(parserFailureMessage("no-job-id", tl)).toBe(
		"[The parser accepted the file but returned no job ID.]"
	);
	expect(parserFailureMessage("timeout", tl)).toBe(
		"[The parser did not finish in time.]"
	);
});

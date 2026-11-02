import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { rotatedTokenDescription } from "./NodeAccessSettings-rotate-toast.ts";

// A stand-in translator that marks every sentence it worded.
const tl = ((source: string) => `«${source}»`) as LiteralMessage;

describe("rotatedTokenDescription", () => {
	test("words the toast itself and never shows Core's English message", () => {
		const coreProse =
			"The new owner token is active. Paired clients are unaffected.";
		expect(
			rotatedTokenDescription(
				{ message: "server prose", restart_required: false },
				tl
			)
		).toBe(`«${coreProse}»`);
		const restart = rotatedTokenDescription(
			{ message: "server prose", restart_required: true },
			tl
		);
		expect(restart).toBe(
			"«The new owner token is saved. Restart Core to finish.»"
		);
		expect(restart).not.toContain("server prose");
	});
});

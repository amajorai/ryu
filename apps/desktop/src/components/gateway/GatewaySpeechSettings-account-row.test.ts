import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { defaultSpeechAccountName } from "./GatewaySpeechSettings-account-row.tsx";

test("an unnamed speech account gets a catalogued default name", () => {
	const tl: LiteralMessage = (source, values) =>
		`[${source}]${values ? JSON.stringify(values) : ""}`;
	expect(defaultSpeechAccountName("0123456789abcdef", tl)).toBe(
		'[Account {id}]{"id":"01234567"}'
	);
});

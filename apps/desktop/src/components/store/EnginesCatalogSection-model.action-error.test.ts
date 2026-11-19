import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { rowActionFailedMessage } from "./EnginesCatalogSection-model.ts";

const seen: string[] = [];
const tl: LiteralMessage = (source, values) => {
	seen.push(source);
	return formatMessage(source, values);
};

describe("rowActionFailedMessage", () => {
	test("each action kind is its own whole sentence", () => {
		seen.length = 0;
		expect(rowActionFailedMessage("install", "llama.cpp", tl)).toBe(
			"Failed to install llama.cpp"
		);
		expect(rowActionFailedMessage("uninstall", "llama.cpp", tl)).toBe(
			"Failed to uninstall llama.cpp"
		);
		expect(rowActionFailedMessage("toggle", "llama.cpp", tl)).toBe(
			"Failed to turn llama.cpp on or off"
		);
		expect(seen.some((source) => source.includes("{kind}"))).toBe(false);
	});
});

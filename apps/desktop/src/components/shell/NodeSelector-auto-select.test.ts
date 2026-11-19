import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { LOCAL_FALLBACK } from "@/src/store/useNodeStore.ts";
import {
	autoSelectPolicy,
	autoSelectSubline,
} from "./NodeSelector-auto-select.tsx";

const tl: LiteralMessage = (source, values) =>
	`[${source}]${values ? JSON.stringify(values) : ""}`;

describe("auto-select sublines", () => {
	test("every state is a catalogued sentence", () => {
		expect(autoSelectSubline(false, null, tl)).toBe(
			"[Always use your default computer]"
		);
		expect(autoSelectSubline(true, null, tl)).toBe(
			"[Prefer a reachable remote computer, else use your computer]"
		);
		expect(autoSelectSubline(true, LOCAL_FALLBACK, tl)).toBe(
			"[No remote computer is reachable, so Ryu is using your computer]"
		);
	});

	test("the switch's accessible name goes through the translator", () => {
		expect(autoSelectPolicy(tl)).toBe(
			"[Prefer a reachable remote computer, else use your computer]"
		);
	});
});

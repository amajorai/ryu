// The shared stream tab handler moves along the reading direction: under
// dir="rtl" the tab row lays out right to left, so ArrowLeft moves forward.
import "./board-test-dom.ts";
import { describe, expect, test } from "bun:test";
import type { KeyboardEvent } from "react";
import { onStreamTabKeyDown } from "./stream-parts.tsx";

const OPTIONS = [{ value: "a" }, { value: "b" }, { value: "c" }] as const;

function pick(direction: "ltr" | "rtl", key: string): string[] {
	const row = document.createElement("div");
	row.style.direction = direction;
	document.body.append(row);
	const picked: string[] = [];
	const event = {
		currentTarget: row,
		key,
		preventDefault: () => undefined,
	} as unknown as KeyboardEvent<HTMLElement>;
	onStreamTabKeyDown(event, "stream", OPTIONS, "b", (value) =>
		picked.push(value)
	);
	row.remove();
	return picked;
}

describe("stream tabs under RTL", () => {
	test("ArrowRight moves forward in LTR", () => {
		expect(pick("ltr", "ArrowRight")).toEqual(["c"]);
	});

	test("ArrowLeft moves forward in RTL", () => {
		expect(pick("rtl", "ArrowLeft")).toEqual(["c"]);
	});

	test("ArrowRight moves back in RTL", () => {
		expect(pick("rtl", "ArrowRight")).toEqual(["a"]);
	});

	test("Home and End ignore direction", () => {
		expect(pick("rtl", "Home")).toEqual(["a"]);
		expect(pick("rtl", "End")).toEqual(["c"]);
	});
});

import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { parseEnvironmentPaste } from "./cloud-environment-input.ts";

describe("cloud environment variable paste", () => {
	test("parses comments, export syntax, quotes and equals in values", () => {
		expect(
			parseEnvironmentPaste('# comment\nexport TOKEN="a=b"\nNAME=demo')
		).toEqual([
			{ key: "TOKEN", value: "a=b" },
			{ key: "NAME", value: "demo" },
		]);
	});
	test("rejects malformed lines and duplicate keys", () => {
		expect(() => parseEnvironmentPaste("not a variable")).toThrow("KEY=value");
		expect(() => parseEnvironmentPaste("TOKEN=a\nTOKEN=b")).toThrow(
			"Duplicate"
		);
	});
	test("rejects reserved process and platform variables", () => {
		for (const key of [
			"PATH",
			"RYU_MASTER_KEY",
			"LD_PRELOAD",
			"NODE_OPTIONS",
		]) {
			expect(() => parseEnvironmentPaste(`${key}=value`)).toThrow("Reserved");
		}
	});
	test("bounds pasted imports", () => {
		expect(() =>
			parseEnvironmentPaste(
				Array.from({ length: 101 }, (_, index) => `KEY_${index}=value`).join(
					"\n"
				)
			)
		).toThrow("100");
	});
	test("every refusal is a catalogued sentence", () => {
		const tl: LiteralMessage = (source, values) =>
			`[${source}]${values ? JSON.stringify(values) : ""}`;
		const refusal = (source: string) => {
			try {
				parseEnvironmentPaste(source, tl);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			return null;
		};
		expect(refusal("not a variable")).toBe("[Use KEY=value on each line.]");
		expect(refusal("PATH=x")).toBe('[Reserved variable: {key}]{"key":"PATH"}');
		expect(refusal("A=1\nA=2")).toBe('[Duplicate variable: {key}]{"key":"A"}');
		expect(
			refusal(Array.from({ length: 101 }, (_, i) => `K_${i}=v`).join("\n"))
		).toBe("[Import up to 100 variables at a time.]");
	});
});

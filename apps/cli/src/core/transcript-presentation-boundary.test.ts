import { expect, test } from "bun:test";
import type { ChatToolArguments } from "./chatTranscript.ts";
import {
	boundToolArguments,
	formatToolOutput,
	sanitizeTerminalText,
	toolArgumentsForPresentation,
} from "./transcriptPresentation.ts";

test("cyclic typed tool records remain bounded before serialization and diff projection", () => {
	const result: ChatToolArguments = { label: "external output" };
	result.output = result;
	expect(formatToolOutput(result)).toContain("tool output depth truncated");
	const args: ChatToolArguments = { rawInput: result };
	expect(JSON.stringify(boundToolArguments(args))).toContain(
		"argument depth truncated"
	);
	expect(() =>
		toolArgumentsForPresentation("Edit", args, result)
	).not.toThrow();
});

test("ANSI removal preserves CSI, greedy OSC terminators and incomplete escape behavior", () => {
	const terminalEscape = String.fromCharCode(0x1b);
	const bell = String.fromCharCode(0x07);
	const verticalTab = String.fromCharCode(0x0b);
	for (const [input, expected] of [
		[`${terminalEscape}[31mred${terminalEscape}[0m`, "red"],
		[`${terminalEscape}]0;title${bell}hello`, "hello"],
		[
			`${terminalEscape}]title${terminalEscape}\\prefix${terminalEscape}\\tail`,
			"tail",
		],
		[`${terminalEscape}]title${terminalEscape}\\prefix${bell}tail`, "tail"],
		[`${terminalEscape}[?25ltext`, "text"],
		[`${terminalEscape}[31${verticalTab}rest`, "[31rest"],
		[`${terminalEscape}]unterminated`, "]unterminated"],
		["first\r\nsecond\tcolumn", "first\nsecond  column"],
	]) {
		expect(sanitizeTerminalText(input ?? "")).toBe(expected ?? "");
	}
});

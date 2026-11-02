import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	isValidNodeName,
	nodeCommandErrorMessage,
	nodeCommandErrorSentence,
} from "./node-command-error.ts";

// A stand-in translator that marks every sentence it worded and fills `{name}`.
const tl = ((source: string, values?: Record<string, unknown>) =>
	`«${source.replace("{name}", String(values?.name ?? ""))}»`) as LiteralMessage;

describe("nodeCommandErrorMessage", () => {
	let warn: ReturnType<typeof spyOn>;
	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => undefined);
	});
	afterEach(() => {
		warn.mockRestore();
	});

	it("words every code the Rust commands send as one translated sentence", () => {
		for (const code of [
			"invalid_name",
			"duplicate_name",
			"not_found",
			"local_node",
			"save_failed",
		]) {
			const sentence = nodeCommandErrorSentence(
				{ code, values: { name: "laptop" } },
				tl
			);
			expect(sentence).toStartWith("«");
			expect(sentence).toEndWith("»");
		}
		expect(
			nodeCommandErrorMessage(
				{ code: "duplicate_name", values: { name: "laptop" } },
				tl
			)
		).toBe("«laptop is already saved. Choose another name.»");
	});

	it("logs a save failure's detail but never shows it", () => {
		const message = nodeCommandErrorMessage(
			{
				code: "save_failed",
				detail: "Permission denied (os error 13)",
				values: { name: "laptop" },
			},
			tl
		);
		expect(message).toBe("«Ryu couldn't save the node list. Try again.»");
		expect(message).not.toContain("os error");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("leaves uncoded failures and unknown codes to the caller", () => {
		expect(nodeCommandErrorMessage(new Error("plan cap"), tl)).toBeNull();
		expect(nodeCommandErrorMessage("node 'x' already exists", tl)).toBeNull();
		expect(nodeCommandErrorMessage({ code: "something_new" }, tl)).toBeNull();
	});
});

describe("isValidNodeName", () => {
	it("matches the Rust rule: letters, digits and hyphens only", () => {
		for (const valid of ["laptop", "mesh-box-2", "Kanäle", "東京"]) {
			expect(isValidNodeName(valid)).toBe(true);
		}
		for (const invalid of ["", "My Laptop", "a_b", "a.b", "a/b"]) {
			expect(isValidNodeName(invalid)).toBe(false);
		}
	});
});

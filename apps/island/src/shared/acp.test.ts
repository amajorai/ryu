import { describe, expect, it } from "bun:test";
import {
	type AcpConfigOption,
	type AcpConfigSelectOption,
	flattenConfigOptions,
} from "./acp.ts";

function option(options: AcpConfigOption["options"]): AcpConfigOption {
	return { id: "opt", name: "Option", options };
}

const A: AcpConfigSelectOption = { name: "A", value: "a" };
const B: AcpConfigSelectOption = { name: "B", value: "b" };
const C: AcpConfigSelectOption = { name: "C", value: "c" };

describe("flattenConfigOptions", () => {
	it("returns an empty array when options are absent or empty", () => {
		expect(flattenConfigOptions(option(undefined))).toEqual([]);
		expect(flattenConfigOptions(option([]))).toEqual([]);
	});

	it("returns a flat option list unchanged", () => {
		expect(flattenConfigOptions(option([A, B]))).toEqual([A, B]);
	});

	it("flattens a grouped (nested { options }) list", () => {
		expect(
			flattenConfigOptions(option([{ options: [A, B] }, { options: [C] }]))
		).toEqual([A, B, C]);
	});
});

import { describe, expect, test } from "bun:test";
import { modelBytesLabel } from "./model-byte-label.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Intl puts a no-break space before the unit; compare on plain spaces. */
const plain = (text: string) => text.replace(/\s/gu, " ");

describe("model byte labels", () => {
	test("reads a file size in English exactly as Core words it", () => {
		expect(modelBytesLabel(5_261_334_937, "4.9 GB", "en")).toBe("4.9 GB");
		expect(modelBytesLabel(3 * GIB + 200 * MIB, "", "en")).toBe("3.2 GB");
		expect(modelBytesLabel(512 * MIB, "", "en")).toBe("512 MB");
		expect(modelBytesLabel(0, "", "en")).toBe("0 B");
	});

	test("rounds to whole GB from 100 GB and never scales to TB", () => {
		expect(modelBytesLabel(128 * GIB, "", "en")).toBe("128 GB");
		expect(modelBytesLabel(2048 * GIB, "", "en")).toBe("2048 GB");
	});

	test("uses the German decimal mark", () => {
		expect(plain(modelBytesLabel(5_261_334_937, "4.9 GB", "de"))).toBe(
			"4,9 GB"
		);
		expect(plain(modelBytesLabel(512 * MIB, "512 MB", "de"))).toBe("512 MB");
	});

	test("falls back to Core's string when the byte count is missing", () => {
		expect(modelBytesLabel(null, "4.9 GB", "de")).toBe("4.9 GB");
		expect(modelBytesLabel(undefined, "16 GB", "de")).toBe("16 GB");
		expect(modelBytesLabel(Number.NaN, "8 GB", "de")).toBe("8 GB");
		expect(modelBytesLabel(null, undefined, "de")).toBe("");
		expect(modelBytesLabel(null, null, "de")).toBe("");
	});
});

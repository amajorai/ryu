import { describe, expect, it } from "bun:test";
import { toFileIndex, withFileIndex } from "./spaces.ts";

// Core's `FileIndexRecord.reason_code` is what lets a failed Spaces file row be
// worded in the reader's language instead of showing the converter's English.
describe("file index reason code", () => {
	it("carries reason_code from the wire onto the document", () => {
		const index = toFileIndex({
			message: "parse exceeded the 600s limit",
			reason_code: "provider_timeout",
			state: "failed",
		});
		expect(index.reasonCode).toBe("provider_timeout");
		expect(withFileIndex(index)).toEqual({
			indexMessage: "parse exceeded the 600s limit",
			indexReasonCode: "provider_timeout",
			indexState: "failed",
			indexWarnings: [],
		});
	});

	it("reads an older node's missing code as null, not as a guess", () => {
		expect(toFileIndex({ state: "failed" }).reasonCode).toBeNull();
		expect(withFileIndex(toFileIndex(undefined)).indexReasonCode).toBeNull();
	});
});

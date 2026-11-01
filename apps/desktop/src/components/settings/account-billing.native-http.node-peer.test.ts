import { describe, expect, test } from "bun:test";
import { authenticatorCode } from "./account-billing.native-http.node-peer.ts";

// RFC 6238 Appendix B SHA-1 seed "12345678901234567890", base32-encoded.
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // Test vector, not a credential. gitleaks:allow skipcq

describe("authenticatorCode", () => {
	test("matches the RFC 6238 SHA-1 vectors (six-digit truncation)", () => {
		expect(authenticatorCode(RFC_SEED, 59_000)).toBe("287082");
		expect(authenticatorCode(RFC_SEED, 1_111_111_109_000)).toBe("081804");
		expect(authenticatorCode(RFC_SEED, 2_000_000_000_000)).toBe("279037");
	});

	test("accepts lowercase and padded setup keys", () => {
		expect(authenticatorCode(`${RFC_SEED.toLowerCase()}==`, 59_000)).toBe(
			"287082"
		);
	});

	test("rejects a key that is not base32", () => {
		expect(() => authenticatorCode("not-base32!", 0)).toThrow(
			"Not a base32 setup key"
		);
	});
});

import { expect, test } from "bun:test";
import { expiryText, usesText } from "./vault-machine-time.ts";

test("a missing expiry never expires; a set one names the time", () => {
	expect(expiryText(null)).toBe("Never expires");
	expect(expiryText("soon")).toBe("Expires soon");
	const text = expiryText(1_900_000_000_000);
	expect(text.startsWith("Expires ")).toBe(true);
	expect(text.length).toBeGreaterThan("Expires ".length);
});

test("use counts are pluralized, and null means unlimited", () => {
	expect(usesText(null)).toBe("Unlimited uses");
	expect(usesText(1)).toBe("1 use left");
	expect(usesText(3)).toBe("3 uses left");
});

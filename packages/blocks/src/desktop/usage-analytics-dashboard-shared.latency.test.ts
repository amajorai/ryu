import { describe, expect, test } from "bun:test";
import { formatMilliseconds } from "./usage-analytics-dashboard-shared.tsx";

const plain = (text: string) => text.replace(/\s/gu, " ");

describe("formatMilliseconds", () => {
	test("keeps whole milliseconds under a second", () => {
		expect(formatMilliseconds(420.4, "en")).toBe("420ms");
		expect(plain(formatMilliseconds(420, "de"))).toBe("420 ms");
	});

	test("switches to seconds with the German decimal comma", () => {
		expect(formatMilliseconds(12_345, "en")).toBe("12.3s");
		expect(plain(formatMilliseconds(12_345, "de"))).toBe("12,3 Sek.");
	});

	test("uses the Japanese and Arabic second units", () => {
		expect(formatMilliseconds(12_345, "ja")).toBe("12.3秒");
		const arabic = formatMilliseconds(12_345, "ar");
		expect(arabic).toContain(new Intl.NumberFormat("ar").format(12.3));
		expect(arabic).toMatch(/[\u0600-\u06ff]/u);
		expect(arabic).not.toContain("s");
	});

	test("reads a missing average as an em dash", () => {
		expect(formatMilliseconds(null, "de")).toBe("—");
	});
});

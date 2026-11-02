import { expect, test } from "bun:test";

const { shortAgo } = await import("./InboxCenter-rows.tsx");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("English keeps the tray's compact age stamps", () => {
	expect(shortAgo(ago(10_000), "en")).toBe("now");
	expect(shortAgo(ago(5 * 60_000 + 1000), "en")).toBe("5m");
	expect(shortAgo(ago(3 * 3_600_000 + 1000), "en")).toBe("3h");
	expect(shortAgo(ago(2 * 86_400_000 + 1000), "en")).toBe("2d");
	expect(shortAgo(null, "en")).toBeNull();
	expect(shortAgo("not a date", "en")).toBeNull();
});

test("other locales get their own short units", () => {
	expect(shortAgo(ago(3 * 3_600_000 + 1000), "ja")).toBe("3時間");
	expect(shortAgo(ago(5 * 60_000 + 1000), "ja")).toBe("5分");
	const arabic = shortAgo(ago(3 * 3_600_000 + 1000), "ar") ?? "";
	expect(arabic).not.toMatch(/[a-z]/u);
	expect(arabic.length).toBeGreaterThan(0);
});

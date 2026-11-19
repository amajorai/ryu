import { expect, test } from "bun:test";
import { formatEstimate } from "./SubscriptionUsageDashboard-cost-breakdown.tsx";

const JA: Record<string, string> = { Unpriced: "価格未設定" };
const ja = (source: string) => JA[source] ?? source;

test("an unpriced estimate reads through the translator", () => {
	expect(formatEstimate(null, ja)).toBe("価格未設定");
});

test("a priced estimate stays a currency amount", () => {
	expect(formatEstimate(2_500_000, ja)).toContain("2.50");
});

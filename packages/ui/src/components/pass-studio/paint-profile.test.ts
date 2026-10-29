import { describe, expect, test } from "bun:test";
import {
	type ProfileFaceContent,
	profileDisplayName,
	profileHeaderMeta,
	profileMetaLine,
	profileStats,
} from "./paint-profile.ts";

const usage = {
	agentHours: 12.345,
	requestCount: 4200,
	streakCurrent: 9,
	streakLongest: 31,
	totalTokens: 1_250_000,
};

describe("profile face helpers", () => {
	test("falls back to a neutral name when the profile has none", () => {
		expect(profileDisplayName("  Ada  ")).toBe("Ada");
		expect(profileDisplayName("   ")).toBe("A Ryu Developer");
		expect(profileDisplayName(null)).toBe("A Ryu Developer");
	});

	test("prints the joined month only when there is one", () => {
		expect(profileHeaderMeta({ joined: "May 2026" })).toBe("Joined May 2026");
		expect(profileHeaderMeta({ joined: null })).toBeNull();
	});

	test("the meta line carries the streak only when usage is public", () => {
		expect(profileMetaLine({ username: "ada", usage })).toBe(
			"@ada · 9-day streak"
		);
		expect(profileMetaLine({ username: "ada" })).toBe("@ada");
		expect(profileMetaLine({})).toBeNull();
	});

	test("stats are empty for a profile with usage hidden", () => {
		const hidden: ProfileFaceContent = { name: "Ada", usage: null };
		expect(profileStats(hidden)).toEqual([]);
	});

	test("stats mirror the profile page's totals", () => {
		const stats = profileStats({ name: "Ada", usage });
		expect(stats.map(([label]) => label)).toEqual([
			"Tokens",
			"Requests",
			"Agent hours",
			"Best streak",
		]);
		expect(stats[2]?.[1]).toBe("12.3h");
		expect(stats[3]?.[1]).toBe("31d");
	});
});

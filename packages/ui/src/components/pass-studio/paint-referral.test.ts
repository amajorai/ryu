import { describe, expect, test } from "bun:test";
import {
	formatPassHours,
	milestoneCardContent,
	questCardContent,
	referralCardSeed,
	referralCardStats,
	referralFacePainter,
	seatsLeft,
} from "./paint-referral.ts";

const INVITE = "https://ryuhq.com/r/ABCD2345";

describe("formatPassHours", () => {
	test("floors to whole hours", () => {
		expect(formatPassHours(99.9)).toBe("99h");
		expect(formatPassHours(0)).toBe("0h");
	});

	test("never prints a negative or non-finite figure", () => {
		expect(formatPassHours(-3)).toBe("0h");
		expect(formatPassHours(Number.NaN)).toBe("0h");
	});
});

describe("seatsLeft", () => {
	test("clamps to the pass size and to zero", () => {
		expect(seatsLeft(5, 2)).toBe(3);
		expect(seatsLeft(5, 9)).toBe(0);
		expect(seatsLeft(5, -1)).toBe(5);
	});
});

describe("milestoneCardContent", () => {
	test("prints only the counts it was handed", () => {
		const content = milestoneCardContent({
			hours: 123.4,
			inviteUrl: INVITE,
			seats: 5,
			seatsClaimed: 2,
			thresholdHours: 100,
		});
		expect(content.kicker).toBe("MILESTONE PASS");
		expect(content.headline).toBe("100h milestone");
		expect(content.meta).toBe("One code for 5 people");
		expect(content.inviteUrl).toBe(INVITE);
		expect(content.stats).toEqual([
			{ label: "Agent time", value: "123h" },
			{ label: "Seats", value: "5" },
			{ label: "Seats left", value: "3" },
			{ label: "Joined", value: "2" },
		]);
	});

	test("keeps the code off the front", () => {
		const content = milestoneCardContent({
			hours: 1,
			inviteUrl: INVITE,
			seats: 1,
			seatsClaimed: 0,
			thresholdHours: 1,
		});
		const printed = [
			content.headline,
			content.meta,
			...content.stats.map((stat) => stat.value),
		].join(" ");
		expect(printed).not.toContain("ABCD2345");
		expect(content.meta).toBe("One code for 1 person");
	});
});

describe("questCardContent", () => {
	test("clamps progress to the target and omits a missing balance", () => {
		const content = questCardContent({
			cadenceLabel: "This month",
			inviteUrl: INVITE,
			progress: 7,
			rewardLabel: "$5.00 credits",
			target: 5,
			title: "Refer 5 friends",
		});
		expect(content.kicker).toBe("BATTLE PASS");
		expect(content.meta).toBe("This month · tier unlocked");
		expect(content.stats).toEqual([
			{ label: "Progress", value: "5/5" },
			{ label: "Reward", value: "$5.00 credits" },
		]);
	});

	test("adds the points balance when the page has it", () => {
		const content = questCardContent({
			pointsBalance: "1,200",
			progress: 5,
			rewardLabel: "500 points",
			target: 5,
			title: "Refer 5 friends",
		});
		expect(content.meta).toBe("Tier unlocked");
		expect(content.stats.at(-1)).toEqual({
			label: "Points balance",
			value: "1,200",
		});
		expect(content.inviteUrl).toBeUndefined();
	});
});

describe("referralCardStats", () => {
	test("drops blanks and caps the grid at four", () => {
		const stats = referralCardStats({
			stats: [
				{ label: "A", value: "1" },
				{ label: "", value: "x" },
				{ label: "B", value: " " },
				{ label: "C", value: "3" },
				{ label: "D", value: "4" },
				{ label: "E", value: "5" },
				{ label: "F", value: "6" },
			],
		});
		expect(stats.map((stat) => stat.label)).toEqual(["A", "C", "D", "E"]);
	});
});

describe("referralCardSeed", () => {
	test("prefers the explicit seed, then the headline", () => {
		expect(referralCardSeed({ headline: "H", seed: "S" })).toBe("S");
		expect(referralCardSeed({ headline: "H", seed: "  " })).toBe("H");
		expect(referralCardSeed({ headline: " " })).toBe("ryu");
	});
});

describe("referralFacePainter", () => {
	test("paints a back so the invite QR is on the card", () => {
		const painter = referralFacePainter(
			milestoneCardContent({
				hours: 100,
				inviteUrl: INVITE,
				seats: 3,
				seatsClaimed: 0,
				thresholdHours: 100,
			})
		);
		expect(typeof painter.front).toBe("function");
		expect(typeof painter.back).toBe("function");
	});
});

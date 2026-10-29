import { expect, test } from "bun:test";
import {
	COST_NOTICE_REQUIRED_CODE,
	costNoticeHeading,
	costNoticeText,
	formatHourlyRate,
	minimumStartWords,
	parseDesktopGrant,
	parseExtendedDeadline,
	parseSessionBoxCostNotice,
	parseSessionBoxCostNoticeState,
	parseSessionBoxStatus,
	sessionBoxKey,
	sessionBoxRefusalText,
} from "./wire.ts";

test("an older Core's status without box, children or caps still parses", () => {
	expect(parseSessionBoxStatus({ conversationId: "conv-1" })).toEqual({
		conversationId: "conv-1",
		box: null,
		children: [],
		caps: null,
		costNotice: null,
	});
});

test("a direct grant must be an absolute WebSocket URL", () => {
	expect(() =>
		parseDesktopGrant({ mode: "direct", url: "/v1/boxes/b/desktop/ws" })
	).toThrow();
	expect(
		parseDesktopGrant({
			mode: "direct",
			url: "wss://box.ryu.test/v1/boxes/b/desktop/ws",
			protocols: ["ryu.box.v1", 7, ""],
		})
	).toMatchObject({ protocols: ["ryu.box.v1"] });
});

test("child keys and extend answers", () => {
	expect(sessionBoxKey("conv-1", 0)).toBe("conv-1#sub:0");
	expect(sessionBoxKey("conv-1", null)).toBe("conv-1");
	expect(parseExtendedDeadline({ expiresAt: "2026-10-19T12:00:00Z" })).toBe(
		"2026-10-19T12:00:00Z"
	);
	expect(parseExtendedDeadline(undefined)).toBeNull();
});

test("refusal codes have readable text and unknown codes defer to the server", () => {
	expect(sessionBoxRefusalText("session_box_limit_reached")).toContain(
		"Box limit"
	);
	expect(sessionBoxRefusalText("session_box_insufficient_credits")).toContain(
		"Top up"
	);
	expect(sessionBoxRefusalText("cloud_task_capacity")).toContain("capacity");
	expect(sessionBoxRefusalText("session_box_not_live")).toContain("parked");
	expect(sessionBoxRefusalText("something_new")).toBeNull();
	expect(sessionBoxRefusalText(undefined)).toBeNull();
});

test("a status with no Box carries the one-time cost notice", () => {
	const status = parseSessionBoxStatus({
		conversationId: "conv-1",
		box: null,
		children: [],
		costNotice: { required: true, size: "small", ratePerHourMicroUsd: 25_000 },
	});
	expect(status.box).toBeNull();
	expect(status.costNotice).toEqual({
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: 25_000,
		size: "small",
		waiting: false,
	});
	expect(
		parseSessionBoxCostNotice({
			required: true,
			size: "small",
			ratePerHourMicroUsd: 25_000,
			minimumSecondsPerStart: 600,
			waiting: true,
		})
	).toEqual({
		minimumSecondsPerStart: 600,
		ratePerHourMicroUsd: 25_000,
		size: "small",
		waiting: true,
	});
	expect(parseSessionBoxCostNotice({ required: false })).toBeNull();
	expect(parseSessionBoxCostNotice("notice")).toBeNull();
	expect(
		parseSessionBoxCostNotice({ required: true, ratePerHourMicroUsd: null })
	).toEqual({
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: null,
		size: null,
		waiting: false,
	});
	expect(
		parseSessionBoxCostNotice({ required: true, ratePerHourMicroUsd: -5 })
	).toEqual({
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: null,
		size: null,
		waiting: false,
	});
});

test("hourly rates read as dollars and the notice names the cost", () => {
	expect(formatHourlyRate(25_000)).toBe("$0.025");
	expect(formatHourlyRate(40_000)).toBe("$0.04");
	expect(formatHourlyRate(70_000)).toBe("$0.07");
	expect(formatHourlyRate(1_500_000)).toBe("$1.50");
	const small = {
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: 25_000,
		size: "small" as const,
		waiting: false,
	};
	expect(costNoticeText(small)).toContain("small: 2 vCPU, 4 GB");
	expect(costNoticeText(small)).toContain("$0.025 an hour");
	expect(costNoticeText(small)).toContain(
		"5-minute minimum each time the Box starts; a resume within the hour already paid owes no new minimum"
	);
	expect(costNoticeHeading(small)).toBe(
		"Computer use starts a cloud Box at $0.025/hour, 5-minute minimum per start"
	);
	expect(
		costNoticeText({ ...small, ratePerHourMicroUsd: null, size: null })
	).toContain("could not read its hourly rate");
	expect(costNoticeHeading({ ...small, ratePerHourMicroUsd: null })).toBe(
		"Computer use starts a paid cloud Box"
	);
	expect(minimumStartWords(90)).toBe("90-second");
	expect(sessionBoxRefusalText(COST_NOTICE_REQUIRED_CODE)).toContain(
		"hourly cost"
	);
	expect(sessionBoxRefusalText("session_box_rate_changed")).toContain(
		"rate changed"
	);
});

test("the owner's cost notice state parses, and a malformed one is refused", () => {
	expect(
		parseSessionBoxCostNoticeState({
			acknowledged: false,
			size: "small",
			ratePerHourMicroUsd: 25_000,
			minimumSecondsPerStart: 300,
		})
	).toEqual({
		acknowledged: false,
		acknowledgedAt: null,
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: 25_000,
		size: "small",
	});
	expect(
		parseSessionBoxCostNoticeState({
			acknowledged: true,
			acknowledgedAt: "2026-10-20T10:00:00Z",
			size: "small",
			ratePerHourMicroUsd: null,
		})
	).toEqual({
		acknowledged: true,
		acknowledgedAt: "2026-10-20T10:00:00Z",
		minimumSecondsPerStart: 300,
		ratePerHourMicroUsd: null,
		size: "small",
	});
	expect(() => parseSessionBoxCostNoticeState({ size: "small" })).toThrow();
	expect(() => parseSessionBoxCostNoticeState(null)).toThrow();
});

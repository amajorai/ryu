import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, describe, expect, it } from "bun:test";
import {
	AFK_TIMEOUT_OPTIONS,
	DEFAULT_USER_AVAILABILITY_SETTINGS,
	getCorePresenceStatus,
	getUserAvailabilitySnapshot,
	resolveUserAvailability,
	setAfkDetectionEnabled,
	setAfkTimeoutMinutes,
	setDetectedGame,
	setDetectedStreamingApp,
	setStreamingPrivacyActive,
	setUserAvailabilityStatus,
	USER_AVAILABILITY_STORAGE_KEY,
	userAvailabilitySettingsSchema,
} from "./user-availability.ts";

const recentActivityAt = 1_000_000;

afterEach(() => {
	localStorage.removeItem(USER_AVAILABILITY_STORAGE_KEY);
	setUserAvailabilityStatus("online");
	setAfkDetectionEnabled(true);
	setAfkTimeoutMinutes(DEFAULT_USER_AVAILABILITY_SETTINGS.afkTimeoutMinutes);
	setDetectedGame(null);
	setDetectedStreamingApp(null);
	setStreamingPrivacyActive(false);
});

describe("resolveUserAvailability", () => {
	it("keeps manual Away and Do not disturb independent of AFK timing", () => {
		const now = recentActivityAt + 60 * 60_000;

		expect(
			resolveUserAvailability(
				{ ...DEFAULT_USER_AVAILABILITY_SETTINGS, manualStatus: "away" },
				now,
				recentActivityAt,
				true
			)
		).toEqual({ source: "manual", status: "away" });
		expect(
			resolveUserAvailability(
				{
					...DEFAULT_USER_AVAILABILITY_SETTINGS,
					manualStatus: "do-not-disturb",
				},
				now,
				recentActivityAt,
				false
			)
		).toEqual({ source: "manual", status: "do-not-disturb" });
	});

	it("turns Online into Away after the configured timeout", () => {
		const settings = {
			...DEFAULT_USER_AVAILABILITY_SETTINGS,
			afkTimeoutMinutes: 5 as const,
		};

		expect(
			resolveUserAvailability(
				settings,
				recentActivityAt + 5 * 60_000,
				recentActivityAt,
				true
			)
		).toEqual({ source: "afk", status: "away" });
	});

	it("treats an unfocused window as Away immediately", () => {
		expect(
			resolveUserAvailability(
				DEFAULT_USER_AVAILABILITY_SETTINGS,
				recentActivityAt + 1000,
				recentActivityAt,
				false
			)
		).toEqual({ source: "afk", status: "away" });
	});

	it("leaves Online alone when AFK detection is disabled", () => {
		expect(
			resolveUserAvailability(
				{ ...DEFAULT_USER_AVAILABILITY_SETTINGS, afkDetectionEnabled: false },
				recentActivityAt + 60 * 60_000,
				recentActivityAt,
				false
			)
		).toEqual({ source: "manual", status: "online" });
	});
});

describe("availability persistence", () => {
	it("persists allowlisted manual status and AFK timeout values", () => {
		setUserAvailabilityStatus("away");
		setAfkDetectionEnabled(false);
		setAfkTimeoutMinutes(AFK_TIMEOUT_OPTIONS[0]);

		const stored = userAvailabilitySettingsSchema.parse(
			JSON.parse(localStorage.getItem(USER_AVAILABILITY_STORAGE_KEY) ?? "{}")
		);
		expect(stored).toMatchObject({
			afkDetectionEnabled: false,
			afkTimeoutMinutes: 5,
			manualStatus: "away",
		});
	});
});

describe("gaming status", () => {
	const now = recentActivityAt + 60_000;

	it("turns a detected game into Gaming over Online and Away", () => {
		for (const manualStatus of ["online", "away"] as const) {
			expect(
				resolveUserAvailability(
					{ ...DEFAULT_USER_AVAILABILITY_SETTINGS, manualStatus },
					now,
					recentActivityAt,
					true,
					"Hades"
				)
			).toEqual({ source: "game", status: "gaming" });
		}
	});

	it("lets a manual Do not disturb win over a detected game", () => {
		expect(
			resolveUserAvailability(
				{
					...DEFAULT_USER_AVAILABILITY_SETTINGS,
					manualStatus: "do-not-disturb",
				},
				now,
				recentActivityAt,
				true,
				"Hades"
			)
		).toEqual({ source: "manual", status: "do-not-disturb" });
	});

	it("keeps a manual Gaming choice without detection", () => {
		expect(
			resolveUserAvailability(
				{ ...DEFAULT_USER_AVAILABILITY_SETTINGS, manualStatus: "gaming" },
				now,
				recentActivityAt,
				true
			)
		).toEqual({ source: "manual", status: "gaming" });
	});

	it("uses Streaming while a configured streaming app is running", () => {
		for (const manualStatus of ["online", "away", "gaming"] as const) {
			expect(
				resolveUserAvailability(
					{ ...DEFAULT_USER_AVAILABILITY_SETTINGS, manualStatus },
					now,
					recentActivityAt,
					true,
					"Hades",
					"obs64"
				)
			).toEqual({ source: "stream", status: "streaming" });
		}
	});

	it("keeps Do not disturb above detected Streaming and accepts manual Streaming", () => {
		expect(
			resolveUserAvailability(
				{
					...DEFAULT_USER_AVAILABILITY_SETTINGS,
					manualStatus: "do-not-disturb",
				},
				now,
				recentActivityAt,
				true,
				null,
				"obs64"
			)
		).toEqual({ source: "manual", status: "do-not-disturb" });
		expect(
			resolveUserAvailability(
				{ ...DEFAULT_USER_AVAILABILITY_SETTINGS, manualStatus: "streaming" },
				now,
				recentActivityAt,
				true
			)
		).toEqual({ source: "manual", status: "streaming" });
	});

	it("folds the Core-detected streaming app into the availability snapshot", () => {
		setDetectedStreamingApp("OBS64");
		expect(getUserAvailabilitySnapshot()).toMatchObject({
			detectedStreamingApp: "OBS64",
			source: "stream",
			status: "streaming",
		});
		setDetectedStreamingApp(null);
		expect(getUserAvailabilitySnapshot().status).toBe("online");
	});

	it("keeps the suggestion privacy guard active under Do not disturb", () => {
		setUserAvailabilityStatus("do-not-disturb");
		setStreamingPrivacyActive(true);
		expect(getUserAvailabilitySnapshot()).toMatchObject({
			status: "do-not-disturb",
			streamingPrivacyActive: true,
		});
	});

	it("folds the Core-detected game into the snapshot", () => {
		setDetectedGame("Hades");
		expect(getUserAvailabilitySnapshot()).toMatchObject({
			detectedGame: "Hades",
			source: "game",
			status: "gaming",
		});
		setDetectedGame(null);
		expect(getUserAvailabilitySnapshot().status).toBe("online");
	});

	it("reports the idle-only status to Core, ignoring a detected game", () => {
		setDetectedGame("Hades");
		expect(getCorePresenceStatus()).toBe("online");
		setUserAvailabilityStatus("gaming");
		expect(getCorePresenceStatus()).toBe("gaming");
	});
});

it("availability storage validates fields independently and retains valid status and timeout choices", () => {
	expect(
		userAvailabilitySettingsSchema.parse({
			afkDetectionEnabled: false,
			afkTimeoutMinutes: 30,
			manualStatus: "gaming",
		})
	).toEqual({
		afkDetectionEnabled: false,
		afkTimeoutMinutes: 30,
		manualStatus: "gaming",
	});
	expect(
		userAvailabilitySettingsSchema.parse({
			afkDetectionEnabled: "false",
			afkTimeoutMinutes: 99,
			manualStatus: "streaming",
		})
	).toEqual({
		...DEFAULT_USER_AVAILABILITY_SETTINGS,
		manualStatus: "streaming",
	});
	expect(userAvailabilitySettingsSchema.safeParse([]).success).toBe(false);
});

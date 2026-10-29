// Desktop user availability.
//
// This is a local interaction policy, not an account-presence claim. The
// Desktop shell owns the setting because AFK detection depends on this window's
// focus and input events; shared chat primitives receive only the resolved
// status through AgentAvailabilityProvider.

import {
	AGENT_AVAILABILITY_OPTIONS,
	type AgentAvailabilityStatus,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { z } from "zod";

import { registerSetting } from "./settings-registry.ts";

export const USER_AVAILABILITY_STORAGE_KEY = "ryu:user-availability";

export const AFK_TIMEOUT_OPTIONS = [5, 10, 15, 30, 60] as const;
export type AfkTimeoutMinutes = (typeof AFK_TIMEOUT_OPTIONS)[number];

export interface UserAvailabilitySettings {
	afkDetectionEnabled: boolean;
	afkTimeoutMinutes: AfkTimeoutMinutes;
	manualStatus: AgentAvailabilityStatus;
}

/** Core detects games and streaming apps from the node-local process table. */
export type AvailabilitySource = "afk" | "game" | "stream" | "manual";

export interface UserAvailabilitySnapshot {
	/** The game Core currently detects, when gaming detection is on. */
	detectedGame: string | null;
	/** Streaming app Core currently detects, when Streaming detection is enabled. */
	detectedStreamingApp: string | null;
	settings: UserAvailabilitySettings;
	source: AvailabilitySource;
	status: AgentAvailabilityStatus;
	/** Core's shared privacy guard, including manual Streaming on organization nodes. */
	streamingPrivacyActive: boolean;
}

export const DEFAULT_USER_AVAILABILITY_SETTINGS: UserAvailabilitySettings = {
	afkDetectionEnabled: true,
	afkTimeoutMinutes: 10,
	manualStatus: "online",
};

const afkTimeoutMinutesSchema = z.literal(AFK_TIMEOUT_OPTIONS);
export const userAvailabilitySettingsSchema = z.object({
	afkDetectionEnabled: z
		.boolean()
		.catch(DEFAULT_USER_AVAILABILITY_SETTINGS.afkDetectionEnabled),
	afkTimeoutMinutes: afkTimeoutMinutesSchema.catch(
		DEFAULT_USER_AVAILABILITY_SETTINGS.afkTimeoutMinutes
	),
	manualStatus: z
		.enum(AGENT_AVAILABILITY_OPTIONS.map((option) => option.value))
		.catch(DEFAULT_USER_AVAILABILITY_SETTINGS.manualStatus),
}) satisfies z.ZodType<UserAvailabilitySettings>;

const STATUS_CHANGE_EVENTS = [
	"pointerdown",
	"pointermove",
	"keydown",
	"wheel",
	"touchstart",
] as const;

const MINUTE_MS = 60_000;
const STATUS_TIMER_MIN_MS = 1000;

const listeners = new Set<() => void>();
let settingsCache = readSettings();
let lastActivityAt = Date.now();
let windowFocused = true;
let tracking = false;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotCache: UserAvailabilitySnapshot | null = null;
let lastScheduledActivityAt = 0;
let detectedGame: string | null = null;
let detectedStreamingApp: string | null = null;
let streamingPrivacyActiveFromCore = false;

const SERVER_SNAPSHOT: UserAvailabilitySnapshot = {
	detectedGame: null,
	detectedStreamingApp: null,
	streamingPrivacyActive: false,
	settings: DEFAULT_USER_AVAILABILITY_SETTINGS,
	source: "manual",
	status: "online",
};

function readSettings(): UserAvailabilitySettings {
	try {
		const raw = localStorage.getItem(USER_AVAILABILITY_STORAGE_KEY);
		if (!raw) {
			return DEFAULT_USER_AVAILABILITY_SETTINGS;
		}
		const parsed = userAvailabilitySettingsSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : DEFAULT_USER_AVAILABILITY_SETTINGS;
	} catch {
		return DEFAULT_USER_AVAILABILITY_SETTINGS;
	}
}

function writeSettings(settings: UserAvailabilitySettings): void {
	try {
		localStorage.setItem(
			USER_AVAILABILITY_STORAGE_KEY,
			JSON.stringify(settings)
		);
	} catch {
		// Local preferences are best-effort; the in-memory setting still applies.
	}
}

/**
 * Precedence: manual Do not disturb, manual or detected Streaming, manual
 * Gaming, detected game, manual Away, AFK auto-away, then Online.
 */
export interface UserAvailabilityResolution {
	source: AvailabilitySource;
	status: AgentAvailabilityStatus;
}

export function resolveUserAvailability(
	settings: UserAvailabilitySettings,
	now: number,
	lastActivity: number,
	focused: boolean,
	game: string | null = null,
	streamingApp: string | null = null
): UserAvailabilityResolution {
	if (settings.manualStatus === "do-not-disturb") {
		return { source: "manual", status: settings.manualStatus };
	}
	if (settings.manualStatus === "streaming") {
		return { source: "manual", status: settings.manualStatus };
	}
	if (streamingApp) {
		return { source: "stream", status: "streaming" };
	}
	if (settings.manualStatus === "gaming") {
		return { source: "manual", status: settings.manualStatus };
	}
	if (game) {
		return { source: "game", status: "gaming" };
	}
	if (settings.manualStatus !== "online") {
		return { source: "manual", status: settings.manualStatus };
	}
	if (
		settings.afkDetectionEnabled &&
		(!focused || now - lastActivity >= settings.afkTimeoutMinutes * MINUTE_MS)
	) {
		return { source: "afk", status: "away" };
	}
	return { source: "manual", status: "online" };
}

function snapshotEqual(
	left: UserAvailabilitySnapshot | null,
	right: UserAvailabilitySnapshot
): boolean {
	return (
		left?.detectedGame === right.detectedGame &&
		left?.detectedStreamingApp === right.detectedStreamingApp &&
		left?.streamingPrivacyActive === right.streamingPrivacyActive &&
		left?.source === right.source &&
		left?.status === right.status &&
		left?.settings.afkDetectionEnabled === right.settings.afkDetectionEnabled &&
		left?.settings.afkTimeoutMinutes === right.settings.afkTimeoutMinutes &&
		left?.settings.manualStatus === right.settings.manualStatus
	);
}

function notify(): void {
	snapshotCache = null;
	for (const listener of listeners) {
		listener();
	}
}

function clearStatusTimer(): void {
	if (statusTimer !== null) {
		clearTimeout(statusTimer);
		statusTimer = null;
	}
}

function scheduleStatusTimer(): void {
	clearStatusTimer();
	if (
		!tracking ||
		settingsCache.manualStatus !== "online" ||
		!settingsCache.afkDetectionEnabled ||
		!windowFocused
	) {
		return;
	}
	if (
		resolveUserAvailability(
			settingsCache,
			Date.now(),
			lastActivityAt,
			windowFocused
		).status !== "online"
	) {
		return;
	}
	lastScheduledActivityAt = lastActivityAt;
	const deadline = lastActivityAt + settingsCache.afkTimeoutMinutes * MINUTE_MS;
	const delay = Math.max(STATUS_TIMER_MIN_MS, deadline - Date.now() + 1);
	statusTimer = setTimeout(() => {
		statusTimer = null;
		notify();
		scheduleStatusTimer();
	}, delay);
}

function updateWindowFocus(focused: boolean): void {
	const previous = getUserAvailabilitySnapshot();
	windowFocused = focused;
	const next = getUserAvailabilitySnapshot();
	if (!snapshotEqual(previous, next)) {
		notify();
	}
	scheduleStatusTimer();
}

function markActivity(): void {
	const previous = getUserAvailabilitySnapshot();
	const now = Date.now();
	lastActivityAt = now;
	windowFocused = true;
	const next = getUserAvailabilitySnapshot();
	const statusChanged = !snapshotEqual(previous, next);
	if (statusChanged) {
		notify();
	}
	if (statusChanged || now - lastScheduledActivityAt >= STATUS_TIMER_MIN_MS) {
		scheduleStatusTimer();
	}
}

function handleWindowBlur(): void {
	updateWindowFocus(false);
}

function handleVisibilityChange(): void {
	if (document.visibilityState === "visible" && document.hasFocus()) {
		markActivity();
		return;
	}
	updateWindowFocus(false);
}

function startTracking(): void {
	if (tracking || globalThis.window === undefined) {
		return;
	}
	tracking = true;
	windowFocused = document.hasFocus();
	for (const eventName of STATUS_CHANGE_EVENTS) {
		window.addEventListener(eventName, markActivity, { passive: true });
	}
	window.addEventListener("focus", markActivity);
	window.addEventListener("blur", handleWindowBlur);
	document.addEventListener("visibilitychange", handleVisibilityChange);
	scheduleStatusTimer();
}

function stopTracking(): void {
	// The app has a long-lived subscriber, but keep the subscription lifecycle
	// honest for isolated component tests and short-lived companion surfaces.
	clearStatusTimer();
	if (globalThis.window !== undefined) {
		for (const eventName of STATUS_CHANGE_EVENTS) {
			window.removeEventListener(eventName, markActivity);
		}
		window.removeEventListener("focus", markActivity);
		window.removeEventListener("blur", handleWindowBlur);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
	}
	tracking = false;
}

function setSettings(next: UserAvailabilitySettings): void {
	const previous = getUserAvailabilitySnapshot();
	settingsCache = next;
	writeSettings(next);
	const current = getUserAvailabilitySnapshot();
	if (!snapshotEqual(previous, current)) {
		notify();
	}
	scheduleStatusTimer();
}

/** Current resolved status, usable by non-React prompt/notification code. */
export function getUserAvailabilitySnapshot(): UserAvailabilitySnapshot {
	const resolution = resolveUserAvailability(
		settingsCache,
		Date.now(),
		lastActivityAt,
		windowFocused,
		detectedGame,
		detectedStreamingApp
	);
	const next: UserAvailabilitySnapshot = {
		detectedGame,
		detectedStreamingApp,
		streamingPrivacyActive:
			streamingPrivacyActiveFromCore ||
			detectedStreamingApp !== null ||
			settingsCache.manualStatus === "streaming",
		settings: settingsCache,
		source: resolution.source,
		status: resolution.status,
	};
	if (!snapshotEqual(snapshotCache, next)) {
		snapshotCache = next;
	}
	return snapshotCache ?? next;
}

/** Stable Online server snapshot for hydration-safe shared chat rendering. */
export function getUserAvailabilityServerSnapshot(): UserAvailabilitySnapshot {
	return SERVER_SNAPSHOT;
}

/** Subscribe to status changes, including local activity and other windows. */
export function subscribeUserAvailability(callback: () => void): () => void {
	listeners.add(callback);
	if (listeners.size === 1) {
		startTracking();
	}
	const onStorage = (event: StorageEvent) => {
		if (event.key !== USER_AVAILABILITY_STORAGE_KEY) {
			return;
		}
		const previous = getUserAvailabilitySnapshot();
		settingsCache = readSettings();
		const next = getUserAvailabilitySnapshot();
		if (!snapshotEqual(previous, next)) {
			notify();
		}
		scheduleStatusTimer();
	};
	if (globalThis.window !== undefined) {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(callback);
		if (globalThis.window !== undefined) {
			window.removeEventListener("storage", onStorage);
		}
		if (listeners.size === 0) {
			stopTracking();
		}
	};
}

/** Set the manual status; Online still allows AFK auto-away when enabled. */
export function setUserAvailabilityStatus(
	manualStatus: AgentAvailabilityStatus
): void {
	setSettings({ ...settingsCache, manualStatus });
}

/** Toggle whether idle or unfocused windows become Away automatically. */
export function setAfkDetectionEnabled(enabled: boolean): void {
	setSettings({ ...settingsCache, afkDetectionEnabled: enabled });
}

/** Set the allowlisted AFK timeout in minutes. */
export function setAfkTimeoutMinutes(minutes: AfkTimeoutMinutes): void {
	if (!afkTimeoutMinutesSchema.safeParse(minutes).success) {
		return;
	}
	setSettings({ ...settingsCache, afkTimeoutMinutes: minutes });
}

/**
 * The status reported to Core, which decides whether agent questions block.
 *
 * Window focus is deliberately ignored: switching to another app for a moment
 * must not turn every question async. Only the idle timeout counts, and input
 * outside the window does not reset it, so a user who has really left becomes
 * Away for Core after the configured timeout. A detected game is left out
 * because Core detects it itself.
 */
export function getCorePresenceStatus(): AgentAvailabilityStatus {
	return resolveUserAvailability(
		settingsCache,
		Date.now(),
		lastActivityAt,
		true
	).status;
}

/** Record the game Core detects (or `null` when none is running). */
export function setDetectedGame(game: string | null): void {
	const next = game?.trim() || null;
	if (next === detectedGame) {
		return;
	}
	const previous = getUserAvailabilitySnapshot();
	detectedGame = next;
	if (!snapshotEqual(previous, getUserAvailabilitySnapshot())) {
		notify();
	}
}

/** Record the streaming app Core detects (or `null` when none is running). */
export function setDetectedStreamingApp(app: string | null): void {
	const next = app?.trim() || null;
	if (next === detectedStreamingApp) {
		return;
	}
	const previous = getUserAvailabilitySnapshot();
	detectedStreamingApp = next;
	if (!snapshotEqual(previous, getUserAvailabilitySnapshot())) {
		notify();
	}
}

/** Record Core's node-wide Connect suggestion privacy state. */
export function setStreamingPrivacyActive(active: boolean): void {
	if (active === streamingPrivacyActiveFromCore) {
		return;
	}
	const previous = getUserAvailabilitySnapshot();
	streamingPrivacyActiveFromCore = active;
	if (!snapshotEqual(previous, getUserAvailabilitySnapshot())) {
		notify();
	}
}

/** Restore the availability policy to its shipped defaults. */
export function resetUserAvailability(): void {
	lastActivityAt = Date.now();
	windowFocused = true;
	setSettings(DEFAULT_USER_AVAILABILITY_SETTINGS);
}

registerSetting({
	category: "general",
	id: "general.availability",
	label: "Availability & prompts",
	reset: resetUserAvailability,
});

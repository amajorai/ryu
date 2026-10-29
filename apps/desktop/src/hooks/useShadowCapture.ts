// apps/desktop/src/hooks/useShadowCapture.ts
//
// Shared state for Shadow's capture controls (frame recording, pause/incognito,
// per-app allowlist). Used by both the Shadow settings tab and the Island
// settings tab so they never diverge.
//
// Shadow holds these as in-memory globals that reset to defaults on restart, so
// the user's choices are persisted locally via tauri-plugin-store (companion.bin,
// the same store the companion ConsentSettings uses) and re-pushed to Shadow on
// mount. That makes a desktop-side toggle survive a Shadow restart. No telemetry;
// purely local storage.

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type CaptureControlUpdate,
	getCaptureControl,
	setCaptureControl,
} from "@/src/lib/api/shadow.ts";

const STORE_FILE = "companion.bin";
const STORE_KEY_PAUSED = "companion_paused";
const STORE_KEY_ALLOWLIST = "companion_app_allowlist";
const STORE_KEY_FRAMES = "companion_frames";
const STORE_KEY_HISTORY_RETENTION_DAYS = "shadow_history_retention_days";
const DEFAULT_HISTORY_RETENTION_DAYS = 30;
const MAX_HISTORY_RETENTION_DAYS = 3650;

let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | null =
	null;

function getStore(): Promise<import("@tauri-apps/plugin-store").Store> {
	if (!storePromise) {
		const pending = import("@tauri-apps/plugin-store").then(({ load }) =>
			load(STORE_FILE)
		);
		storePromise = pending;
		// Retry a failed load, while retaining the valid Store after a key read refusal.
		void pending.catch(() => {
			if (storePromise === pending) {
				storePromise = null;
			}
		});
	}
	return storePromise;
}

async function readBool(key: string, fallback: boolean): Promise<boolean> {
	const store = await getStore();
	const value = await store.get<unknown>(key);
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`Invalid saved capture preference: ${key}`);
	}
	return value;
}
async function readList(key: string): Promise<string[]> {
	const store = await getStore();
	const value = await store.get<unknown>(key);
	if (value === undefined) {
		return [];
	}
	if (
		!(Array.isArray(value) && value.every((item) => typeof item === "string"))
	) {
		throw new Error(`Invalid saved capture preference: ${key}`);
	}
	return value;
}
async function readNumber(key: string, fallback: number): Promise<number> {
	const store = await getStore();
	const value = await store.get<unknown>(key);
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Invalid saved capture preference: ${key}`);
	}
	return value;
}

async function writeValues(values: Record<string, unknown>): Promise<boolean> {
	try {
		const store = await getStore();
		for (const [key, value] of Object.entries(values)) {
			await store.set(key, value);
		}
		await store.save();
		return true;
	} catch {
		return false;
	}
}

function normalizeRetentionDays(days: number): number {
	if (!Number.isFinite(days)) {
		return DEFAULT_HISTORY_RETENTION_DAYS;
	}
	return Math.max(1, Math.min(MAX_HISTORY_RETENTION_DAYS, Math.round(days)));
}

export interface ShadowCaptureState {
	/** Per-app allowlist. Empty = allow all. */
	allowlist: string[];
	captureApplying: boolean;
	captureError: boolean;
	captureReadError: boolean;
	/** Frame (keyframe) recording enabled. */
	frames: boolean;
	/** Total days Shadow keeps captured Timeline/search history. */
	historyRetentionDays: number;
	/** Global pause/incognito. */
	paused: boolean;
	persistenceError: boolean;
	/** False until persisted settings are loaded and pushed to Shadow. */
	ready: boolean;
	/** Probe the local Shadow sidecar and refresh the reachability state. */
	refreshShadow: () => Promise<boolean>;
	retryCaptureSettings: () => Promise<void>;
	setAllowlist: (list: string[]) => Promise<void>;
	setFrames: (enabled: boolean) => Promise<void>;
	setHistoryRetentionDays: (days: number) => Promise<void>;
	setPaused: (paused: boolean) => Promise<void>;
	/** Null until first push; false when Shadow is unreachable. */
	shadowReachable: boolean | null;
}

/**
 * Read persisted Shadow capture settings, push them to the live Shadow sidecar,
 * and expose setters that update both the local store and Shadow at once. Frame
 * recording defaults to on so the timeline shows screenshots out of the box.
 */
export function useShadowCapture(): ShadowCaptureState {
	const [frames, setFramesState] = useState(true);
	const [historyRetentionDays, setHistoryRetentionDaysState] = useState(
		DEFAULT_HISTORY_RETENTION_DAYS
	);
	const [paused, setPausedState] = useState(false);
	const [allowlist, setAllowlistState] = useState<string[]>([]);
	const [ready, setReady] = useState(false);
	const [shadowReachable, setShadowReachable] = useState<boolean | null>(null);
	const [captureApplying, setCaptureApplying] = useState(false);
	const [captureError, setCaptureError] = useState(false);
	const [captureReadError, setCaptureReadError] = useState(false);
	const [persistenceError, setPersistenceError] = useState(false);
	const applying = useRef(false);
	const mounted = useRef(false);
	const loadedPreferences = useRef(false);
	const operation = useRef(0);
	const desired = useRef({
		frames: true,
		paused: false,
		app_allowlist: [] as string[],
		history_retention_days: DEFAULT_HISTORY_RETENTION_DAYS,
	});

	const loadCaptureSettings = useCallback(async () => {
		if (applying.current || !mounted.current) {
			return;
		}
		applying.current = true;
		const currentOperation = ++operation.current;
		setCaptureApplying(true);
		try {
			const [savedFrames, savedPaused, savedList, savedRetentionDays] =
				await Promise.all([
					readBool(STORE_KEY_FRAMES, true),
					readBool(STORE_KEY_PAUSED, false),
					readList(STORE_KEY_ALLOWLIST),
					readNumber(
						STORE_KEY_HISTORY_RETENTION_DAYS,
						DEFAULT_HISTORY_RETENTION_DAYS
					),
				]);
			if (!mounted.current || currentOperation !== operation.current) {
				return;
			}
			desired.current = {
				frames: savedFrames,
				paused: savedPaused,
				app_allowlist: savedList,
				history_retention_days: normalizeRetentionDays(savedRetentionDays),
			};
			loadedPreferences.current = true;
			setFramesState(savedFrames);
			setPausedState(savedPaused);
			setAllowlistState(savedList);
			setHistoryRetentionDaysState(normalizeRetentionDays(savedRetentionDays));
			setCaptureReadError(false);
			const ctrl = await setCaptureControl({ ...desired.current });
			if (!mounted.current || currentOperation !== operation.current) {
				return;
			}
			setShadowReachable(ctrl !== null);
			setCaptureError(ctrl === null);
			if (ctrl) {
				setHistoryRetentionDaysState(
					normalizeRetentionDays(ctrl.history_retention_days)
				);
			}
			setReady(true);
		} catch {
			if (mounted.current && currentOperation === operation.current) {
				// Unknown saved state must never be replaced by a default unpause.
				loadedPreferences.current = false;
				setCaptureReadError(true);
				setReady(false);
			}
		} finally {
			if (mounted.current && currentOperation === operation.current) {
				applying.current = false;
				setCaptureApplying(false);
			}
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void loadCaptureSettings();
		return () => {
			mounted.current = false;
			operation.current += 1;
			applying.current = false;
		};
	}, [loadCaptureSettings]);

	const applyCapture = useCallback(async (update: CaptureControlUpdate) => {
		// Blur/Enter or a second click must not overlap an outstanding capture write.
		if (applying.current || !mounted.current || !loadedPreferences.current) {
			return;
		}
		applying.current = true;
		const currentOperation = ++operation.current;
		setCaptureApplying(true);
		desired.current = { ...desired.current, ...update };
		const values: Record<string, unknown> = {};
		if (update.frames !== undefined) {
			values[STORE_KEY_FRAMES] = update.frames;
			setFramesState(update.frames);
		}
		if (update.paused !== undefined) {
			values[STORE_KEY_PAUSED] = update.paused;
			setPausedState(update.paused);
		}
		if (update.app_allowlist !== undefined) {
			values[STORE_KEY_ALLOWLIST] = update.app_allowlist;
			setAllowlistState(update.app_allowlist);
		}
		if (update.history_retention_days !== undefined) {
			values[STORE_KEY_HISTORY_RETENTION_DAYS] = update.history_retention_days;
			setHistoryRetentionDaysState(update.history_retention_days);
		}
		// A local disk refusal must not prevent an accepted privacy pause.
		const persisted = await writeValues(values);
		const ctrl = await setCaptureControl(update);
		if (!mounted.current || currentOperation !== operation.current) {
			return;
		}
		const fullPreferences = Object.keys(values).length === 4;
		// A successful unrelated sparse write cannot repair an earlier failed preference.
		setPersistenceError(
			(current) => !persisted || (current && !fullPreferences)
		);
		setCaptureError(
			(current) => ctrl === null || (current && !fullPreferences)
		);
		setShadowReachable(ctrl !== null);
		if (ctrl) {
			setHistoryRetentionDaysState(
				normalizeRetentionDays(ctrl.history_retention_days)
			);
		}
		applying.current = false;
		setCaptureApplying(false);
	}, []);

	const setFrames = useCallback(
		(enabled: boolean) => applyCapture({ frames: enabled }),
		[applyCapture]
	);
	const setPaused = useCallback(
		(next: boolean) => applyCapture({ paused: next }),
		[applyCapture]
	);
	const setAllowlist = useCallback(
		(list: string[]) => applyCapture({ app_allowlist: list }),
		[applyCapture]
	);
	const setHistoryRetentionDays = useCallback(
		(days: number) =>
			applyCapture({ history_retention_days: normalizeRetentionDays(days) }),
		[applyCapture]
	);
	const retryCaptureSettings = useCallback(
		() =>
			loadedPreferences.current
				? applyCapture({ ...desired.current })
				: loadCaptureSettings(),
		[applyCapture, loadCaptureSettings]
	);

	const refreshShadow = useCallback(async () => {
		const ctrl = await getCaptureControl();
		const reachable = ctrl !== null;
		setShadowReachable(reachable);
		return reachable;
	}, []);

	return {
		captureApplying,
		captureError,
		captureReadError,
		persistenceError,
		retryCaptureSettings,
		allowlist,
		frames,
		historyRetentionDays,
		paused,
		ready,
		setAllowlist,
		setFrames,
		setHistoryRetentionDays,
		setPaused,
		refreshShadow,
		shadowReachable,
	};
}

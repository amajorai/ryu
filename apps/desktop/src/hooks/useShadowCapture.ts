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

import { useCallback, useEffect, useState } from "react";
import { setCaptureControl } from "@/src/lib/api/shadow.ts";

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
		storePromise = import("@tauri-apps/plugin-store").then(({ load }) =>
			load(STORE_FILE)
		);
	}
	return storePromise;
}

async function readBool(key: string, fallback: boolean): Promise<boolean> {
	try {
		const store = await getStore();
		return (await store.get<boolean>(key)) ?? fallback;
	} catch {
		return fallback;
	}
}

async function readList(key: string): Promise<string[]> {
	try {
		const store = await getStore();
		return (await store.get<string[]>(key)) ?? [];
	} catch {
		return [];
	}
}

async function readNumber(key: string, fallback: number): Promise<number> {
	try {
		const store = await getStore();
		return (await store.get<number>(key)) ?? fallback;
	} catch {
		return fallback;
	}
}

async function writeValue(key: string, value: unknown): Promise<void> {
	try {
		const store = await getStore();
		await store.set(key, value);
		await store.save();
	} catch {
		// Non-fatal: settings are best-effort.
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
	/** Frame (keyframe) recording enabled. */
	frames: boolean;
	/** Total days Shadow keeps captured Timeline/search history. */
	historyRetentionDays: number;
	/** Global pause/incognito. */
	paused: boolean;
	/** False until persisted settings are loaded and pushed to Shadow. */
	ready: boolean;
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

	useEffect(() => {
		let cancelled = false;
		Promise.all([
			readBool(STORE_KEY_FRAMES, true),
			readBool(STORE_KEY_PAUSED, false),
			readList(STORE_KEY_ALLOWLIST),
			readNumber(
				STORE_KEY_HISTORY_RETENTION_DAYS,
				DEFAULT_HISTORY_RETENTION_DAYS
			),
		]).then(
			async ([savedFrames, savedPaused, savedList, savedRetentionDays]) => {
				if (cancelled) {
					return;
				}
				setFramesState(savedFrames);
				setPausedState(savedPaused);
				setAllowlistState(savedList);
				setHistoryRetentionDaysState(
					normalizeRetentionDays(savedRetentionDays)
				);
				// Push persisted state to Shadow (may have restarted since last run).
				const ctrl = await setCaptureControl({
					frames: savedFrames,
					paused: savedPaused,
					app_allowlist: savedList,
					history_retention_days: normalizeRetentionDays(savedRetentionDays),
				});
				if (!cancelled) {
					setShadowReachable(ctrl !== null);
					if (ctrl) {
						setHistoryRetentionDaysState(
							normalizeRetentionDays(ctrl.history_retention_days)
						);
					}
					setReady(true);
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, []);

	const setFrames = useCallback(async (enabled: boolean) => {
		setFramesState(enabled);
		await writeValue(STORE_KEY_FRAMES, enabled);
		const ctrl = await setCaptureControl({ frames: enabled });
		setShadowReachable(ctrl !== null);
	}, []);

	const setHistoryRetentionDays = useCallback(async (days: number) => {
		const normalizedDays = normalizeRetentionDays(days);
		setHistoryRetentionDaysState(normalizedDays);
		await writeValue(STORE_KEY_HISTORY_RETENTION_DAYS, normalizedDays);
		const ctrl = await setCaptureControl({
			history_retention_days: normalizedDays,
		});
		setShadowReachable(ctrl !== null);
		if (ctrl) {
			setHistoryRetentionDaysState(
				normalizeRetentionDays(ctrl.history_retention_days)
			);
		}
	}, []);

	const setPaused = useCallback(async (next: boolean) => {
		setPausedState(next);
		await writeValue(STORE_KEY_PAUSED, next);
		const ctrl = await setCaptureControl({ paused: next });
		setShadowReachable(ctrl !== null);
	}, []);

	const setAllowlist = useCallback(async (list: string[]) => {
		setAllowlistState(list);
		await writeValue(STORE_KEY_ALLOWLIST, list);
		const ctrl = await setCaptureControl({ app_allowlist: list });
		setShadowReachable(ctrl !== null);
	}, []);

	return {
		allowlist,
		frames,
		historyRetentionDays,
		paused,
		ready,
		setAllowlist,
		setFrames,
		setHistoryRetentionDays,
		setPaused,
		shadowReachable,
	};
}

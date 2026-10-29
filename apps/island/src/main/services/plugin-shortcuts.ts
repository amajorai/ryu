import { z } from "zod";
import type { PluginContributionsResult } from "../../shared/ipc.ts";
import type { KeybindingOverrides } from "../../shared/keybindings.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { pluginContributions } from "./plugin-host.ts";
import { withResponseDeadline } from "./response-deadline.ts";

/** Timeout for the saved shortcut document read. */
const READ_TIMEOUT_MS = 5000;
const preferenceEnvelopeSchema = z.object({ value: z.string().nullable() });
const savedOverridesSchema = z.record(z.string(), z.string().nullable());

/**
 * The user's saved `keybindings` document, `{}` when it is genuinely unset, or
 * `null` when Core's answer cannot be trusted as the user's settings (refused,
 * timed out, or malformed). Mirrors Desktop's whole-document validation so the
 * two processes agree on what counts as a readable document.
 */
async function readSavedOverrides(): Promise<KeybindingOverrides | null> {
	try {
		return await withResponseDeadline(
			`${loadConfig().coreBaseUrl}/api/preferences/keybindings`,
			{ headers: coreHeaders() },
			READ_TIMEOUT_MS,
			async (response) => {
				if (response.status === 404) {
					return {};
				}
				if (!response.ok) {
					return null;
				}
				const envelope = preferenceEnvelopeSchema.safeParse(
					await response.json()
				);
				if (!envelope.success) {
					return null;
				}
				if (envelope.data.value === null) {
					return {};
				}
				const saved = savedOverridesSchema.safeParse(
					JSON.parse(envelope.data.value)
				);
				return saved.success ? saved.data : null;
			}
		);
	} catch {
		return null;
	}
}

/** First automatic re-read after an unreadable or unavailable snapshot. */
const RETRY_DELAY_MS = 2000;
/** Ceiling for the doubling retry delay while Core keeps refusing. */
const MAX_RETRY_DELAY_MS = 60_000;
/**
 * Cadence of the idle re-read that notices a plugin enabled, disabled or updated
 * in Core. Core announces those changes only on its realtime `system:plugins`
 * room, which the Island's main process does not join, so the enabled set is
 * re-read on this cadence instead (two loopback GETs per tick).
 */
const POLL_INTERVAL_MS = 10_000;

/** Re-read and apply plugin shortcuts; stoppable when the Island quits. */
export interface PluginShortcutRefresh {
	/** Cancel any scheduled re-read and ignore snapshots still in flight. */
	dispose(): void;
	/**
	 * Change Island-owned chords (command summon, push-to-talk, dictation) and
	 * re-reconcile plugin chords around the change: every plugin chord is released
	 * first so an Island chord can claim one a plugin held, `change` runs, and the
	 * last acknowledged snapshot is re-applied against the new reserved set, so a
	 * chord the Island gave up goes straight back to its plugin. Synchronous and
	 * Core-free; before any snapshot is acknowledged only `change` runs.
	 */
	rebindReserved(change: () => void): void;
	(): Promise<void>;
}

export interface PluginShortcutRefreshOptions {
	/** Upper bound for the doubled delay. */
	maxRetryDelayMs?: number;
	/** Idle re-read cadence; `0` disables polling. */
	pollIntervalMs?: number;
	/** Delay before the first automatic re-read; doubles per failed attempt. */
	retryDelayMs?: number;
}

/** The fields of an applied snapshot that decide which chords are registered. */
function snapshotKey(
	result: PluginContributionsResult,
	overrides: KeybindingOverrides
): string {
	if (!result.available) {
		return "unavailable";
	}
	return JSON.stringify([
		result.companions.map((companion) => [
			companion.id,
			companion.pluginId,
			companion.shortcut,
		]),
		overrides,
	]);
}

/**
 * Keep current bindings during reads; collapse bursts into a fresh trailing read.
 * An unreadable saved document also keeps the acknowledged bindings: manifest
 * defaults must never replace a user's cleared or rebound chord just because
 * Core could not answer. An unavailable plugin host still releases every chord.
 *
 * Production refreshes at startup, on a live `keybindings` event and when the
 * Core target changes. Because Core does not stream plugin enable/disable to the
 * Island, an idle poll re-reads the snapshot every `pollIntervalMs` and applies
 * it only when the companions or saved shortcuts changed (an unchanged poll
 * makes no OS calls). The preference stream does not replay on reconnect, so a
 * snapshot that is not acknowledged (unreadable document or unavailable plugin
 * host) schedules its own re-read on a capped doubling backoff until one is.
 * Any refresh cancels the pending re-read; an acknowledged snapshot ends the
 * loop and resets it. `dispose()` (on quit) cancels re-reads and polling and
 * drops snapshots still in flight.
 */
export function createPluginShortcutRefresh(
	apply: (
		result: PluginContributionsResult,
		overrides: KeybindingOverrides
	) => void,
	{
		retryDelayMs = RETRY_DELAY_MS,
		maxRetryDelayMs = MAX_RETRY_DELAY_MS,
		pollIntervalMs = POLL_INTERVAL_MS,
	}: PluginShortcutRefreshOptions = {}
): PluginShortcutRefresh {
	let generation = 0;
	let pending: Promise<void> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let failedAttempts = 0;
	let disposed = false;
	/** A refresh other than an idle poll asked for the next snapshot to apply. */
	let forceApply = false;
	/** The snapshot last handed to `apply`, re-applied when reserved chords move. */
	let applied: {
		key: string;
		overrides: KeybindingOverrides;
		result: PluginContributionsResult;
	} | null = null;
	/** Resolves to whether the applied snapshot was acknowledged by Core. */
	const run = async (): Promise<boolean> => {
		for (;;) {
			const current = generation;
			const [result, overrides] = await Promise.all([
				pluginContributions(),
				readSavedOverrides(),
			]);
			// After quit the OS chords are already released; never re-register.
			if (disposed) {
				return true;
			}
			if (current !== generation) {
				continue;
			}
			if (result.available && overrides === null) {
				return false;
			}
			const saved = overrides ?? {};
			const key = snapshotKey(result, saved);
			if (forceApply || applied?.key !== key) {
				applied = { key, overrides: saved, result };
				apply(result, saved);
			}
			forceApply = false;
			if (current === generation) {
				return result.available;
			}
		}
	};
	const unref = (timer: ReturnType<typeof setTimeout>) => {
		// A re-read must never be the only thing keeping the process alive.
		if (typeof timer === "object" && "unref" in timer) {
			timer.unref();
		}
	};
	const cancelRetry = () => {
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
	};
	const scheduleRetry = () => {
		if (disposed) {
			return;
		}
		const delay = Math.min(retryDelayMs * 2 ** failedAttempts, maxRetryDelayMs);
		failedAttempts = Math.min(failedAttempts + 1, 30);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			refresh().catch(() => undefined);
		}, delay);
		unref(retryTimer);
	};
	const schedulePoll = () => {
		if (disposed || pollTimer !== null || !(pollIntervalMs > 0)) {
			return;
		}
		pollTimer = setTimeout(() => {
			pollTimer = null;
			// A read in flight or a scheduled retry already owns the next snapshot;
			// it re-arms the poll when it settles.
			if (pending === null && retryTimer === null) {
				start(false).catch(() => undefined);
			}
		}, pollIntervalMs);
		unref(pollTimer);
	};
	const start = (force: boolean): Promise<void> => {
		if (disposed) {
			return Promise.resolve();
		}
		if (force) {
			forceApply = true;
		}
		generation++;
		cancelRetry();
		pending ??= run().then(
			(acknowledged) => {
				pending = null;
				if (acknowledged) {
					failedAttempts = 0;
				} else {
					scheduleRetry();
				}
				schedulePoll();
			},
			(error: unknown) => {
				pending = null;
				schedulePoll();
				throw error;
			}
		);
		return pending;
	};
	const refresh = (): Promise<void> => start(true);
	return Object.assign(refresh, {
		dispose() {
			disposed = true;
			cancelRetry();
			if (pollTimer !== null) {
				clearTimeout(pollTimer);
				pollTimer = null;
			}
		},
		rebindReserved(change: () => void) {
			const snapshot = disposed ? null : applied;
			if (snapshot) {
				apply({ available: false, reason: "reserved chords changing" }, {});
			}
			try {
				change();
			} finally {
				if (snapshot && !disposed) {
					apply(snapshot.result, snapshot.overrides);
				}
			}
		},
	});
}

import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/store/useClipStore.ts
//
// The recording state for Ryu Clips (agent-native Loom/Jam). Holds the live
// recorder status, capture-source toggles, the finished-clip list, and the last
// finalized context. The 1s elapsed-timer tick is DRIVEN BY the component
// (RecordingControls owns a `setInterval` and calls `tick()`), never by the
// store - a store must not own timers, so the effect can be cleaned up with the
// component's lifecycle. Pattern mirrors `useNodeStore` / `useMeetingRecordingStore`.

import { z } from "zod";
import { create } from "zustand";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ClipCaptureSources,
	type ClipContext,
	type ClipStartOpts,
	type ClipSummary,
	type ClipTarget,
	listClips,
	pauseClip,
	resumeClip,
	startClip,
	stopClip,
} from "@/src/lib/api/clips.ts";

/** Default audio capture: mic on, system audio off, matching a "record what I'm
 * doing and narrate it" clip. */
const DEFAULT_SOURCES: ClipCaptureSources = {
	mic: true,
	systemAudio: false,
};

/** Default video surface: the primary display in full (zero-config). */
const DEFAULT_TARGET: ClipTarget = { kind: "screen" };

/** Map the UI toggle set + chosen surface to Shadow's start payload. Video is
 * always captured (the picker always resolves a surface); mic/system-audio are
 * the independent audio inputs. `displayId` is mirrored for back-compat. */
function toStartOpts(
	sources: ClipCaptureSources,
	target: ClipTarget
): ClipStartOpts {
	return {
		screen: true,
		mic: sources.mic,
		systemAudio: sources.systemAudio,
		target,
		displayId: target.kind === "display" ? target.displayId : undefined,
	};
}

const BASE64URL_DASH = /-/g;
const BASE64URL_UNDERSCORE = /_/g;

/** The stable claims of a managed-node delegation. Everything else (`jti`,
 * `iat`, `exp`, the signature) changes on every control-plane `/nodes` fetch. */
const delegationIdentitySchema = z.object({
	iss: z.string().nullish(),
	sub: z.string(),
	org_id: z.string().nullish(),
	node_id: z.string().nullish(),
	team_id: z.string().nullish(),
});

/**
 * Who a managed-node delegation speaks for, independent of its rotation. The
 * desktop re-mints the delegation on every window focus and every 10 minutes
 * (`useNodeStore.refreshCloudTokens`), so keying a recording on the raw JWT would
 * end it on the first refresh. This is a scoping key, not an authorization
 * check: the node verifies the signature. An undecodable value falls back to
 * the raw JWT, which keeps the strict per-credential scope.
 */
function delegationIdentity(userJwt: string | null | undefined): string | null {
	if (!userJwt) {
		return null;
	}
	const payload = userJwt.split(".")[1];
	if (!payload) {
		return userJwt;
	}
	try {
		const base64 = payload
			.replace(BASE64URL_DASH, "+")
			.replace(BASE64URL_UNDERSCORE, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const parsed = delegationIdentitySchema.safeParse(JSON.parse(atob(padded)));
		if (!parsed.success) {
			return userJwt;
		}
		const claims = parsed.data;
		return JSON.stringify([
			claims.iss ?? null,
			claims.sub,
			claims.org_id ?? null,
			claims.node_id ?? null,
			claims.team_id ?? null,
		]);
	} catch {
		return userJwt;
	}
}

/**
 * The identity a recording belongs to: node URL, node bearer, and the stable
 * identity behind a managed-node delegation. A rotated delegation for the same
 * user/org/node keeps the scope; a different node, bearer, or user changes it.
 */
export function recordingScope(target: ApiTarget): string {
	return JSON.stringify([
		target.url,
		target.token,
		delegationIdentity(target.userJwt),
	]);
}

let recordingEpoch = 0;

interface ClipState {
	/** Forget a recording that belongs to another scope, first asking the node
	 * that owns it (best effort) to stop capturing so screen/mic never keep
	 * running with no Stop control. */
	abandonRecording: () => void;
	/** The chosen video surface sent on start. */
	captureTarget: ClipTarget;
	clipId: string | null;
	clips: ClipSummary[];
	elapsedMs: number;
	error: string | null;
	/** True while a real backend pause is in effect (capture held, timer frozen). */
	isPaused: boolean;
	lastContext: ClipContext | null;
	/** Pause the live recording on the backend and freeze the timer. */
	pause: (target: ApiTarget) => Promise<void>;
	pendingAction: "pause" | "resume" | null;
	refresh: (target: ApiTarget) => Promise<void>;
	resetRecording: () => void;
	/** Resume a paused recording; resyncs the timer to backend duration. */
	resume: (target: ApiTarget) => Promise<void>;
	sessionScope: string | null;
	/** The latest credentials for the node that owns the recording. Kept so a
	 * recording abandoned after a scope change can still be stopped there. */
	sessionTarget: ApiTarget | null;
	setCaptureTarget: (target: ClipTarget) => void;
	setSource: (key: keyof ClipCaptureSources, value: boolean) => void;
	sources: ClipCaptureSources;
	start: (target: ApiTarget) => Promise<void>;
	startedAtMs: number | null;
	status: "idle" | "starting" | "recording" | "stopping";
	stop: (target: ApiTarget) => Promise<ClipContext | null>;
	/** Adopt fresh credentials (a rotated delegation) for the recording's own
	 * scope; a target from another scope is ignored. */
	syncSessionTarget: (target: ApiTarget) => void;
	/** Recompute `elapsedMs` from the start stamp. Called by the component's timer. */
	tick: () => void;
}

export const useClipStore = create<ClipState>((set, get) => ({
	sessionScope: null,
	sessionTarget: null,
	resetRecording: () => {
		recordingEpoch++;
		set({
			status: "idle",
			clipId: null,
			startedAtMs: null,
			elapsedMs: 0,
			isPaused: false,
			pendingAction: null,
			error: null,
			sessionScope: null,
			sessionTarget: null,
		});
	},
	abandonRecording: () => {
		const { clipId, sessionTarget } = get();
		get().resetRecording();
		if (clipId && sessionTarget) {
			stopClip(sessionTarget, clipId).catch(() => undefined);
		}
	},
	syncSessionTarget: (target) => {
		const { sessionScope, status } = get();
		if (status !== "idle" && sessionScope === recordingScope(target)) {
			set({ sessionTarget: target });
		}
	},
	status: "idle",
	clipId: null,
	startedAtMs: null,
	elapsedMs: 0,
	isPaused: false,
	pendingAction: null,
	sources: DEFAULT_SOURCES,
	captureTarget: DEFAULT_TARGET,
	clips: [],
	lastContext: null,
	error: null,

	setSource: (key, value) => {
		set((s) => ({ sources: { ...s.sources, [key]: value } }));
	},

	setCaptureTarget: (target) => {
		set({ captureTarget: target });
	},

	start: async (target) => {
		if (get().status !== "idle") {
			return;
		}
		const epoch = ++recordingEpoch;
		set({
			status: "starting",
			error: null,
			elapsedMs: 0,
			isPaused: false,
			sessionScope: recordingScope(target),
			sessionTarget: target,
		});
		try {
			const ctx = await startClip(
				target,
				toStartOpts(get().sources, get().captureTarget)
			);
			if (epoch !== recordingEpoch) {
				return;
			}
			set({
				status: "recording",
				clipId: ctx.id,
				startedAtMs: Date.now(),
				elapsedMs: 0,
			});
		} catch (err) {
			if (epoch !== recordingEpoch) {
				return;
			}
			set({
				status: "idle",
				clipId: null,
				startedAtMs: null,
				error: err instanceof Error ? err.message : "Failed to start recording",
			});
		}
	},

	pause: async (target) => {
		if (get().sessionScope !== recordingScope(target)) {
			get().abandonRecording();
			return;
		}
		const epoch = recordingEpoch;
		const { status, clipId, isPaused, pendingAction } = get();
		if (status !== "recording" || !clipId || isPaused || pendingAction) {
			return;
		}
		// Optimistic: freeze the timer immediately, revert if the backend rejects.
		set({ isPaused: true, pendingAction: "pause", error: null });
		try {
			const ctx = await pauseClip(target, clipId);
			if (epoch !== recordingEpoch) {
				return;
			}
			const frozen = isNativeNumber(ctx.durationMs)
				? ctx.durationMs
				: get().elapsedMs;
			set({ elapsedMs: frozen, pendingAction: null });
		} catch (err) {
			if (epoch !== recordingEpoch) {
				return;
			}
			set({
				isPaused: false,
				pendingAction: null,
				error: err instanceof Error ? err.message : "Failed to pause recording",
			});
		}
	},

	resume: async (target) => {
		if (get().sessionScope !== recordingScope(target)) {
			get().abandonRecording();
			return;
		}
		const epoch = recordingEpoch;
		const { status, clipId, isPaused, pendingAction } = get();
		if (status !== "recording" || !clipId || !isPaused || pendingAction) {
			return;
		}
		try {
			set({ pendingAction: "resume", error: null });
			const ctx = await resumeClip(target, clipId);
			if (epoch !== recordingEpoch) {
				return;
			}
			// Re-anchor the start stamp so the tick continues from the backend's
			// duration (which excludes the paused span) rather than wall clock.
			const base = isNativeNumber(ctx.durationMs)
				? ctx.durationMs
				: get().elapsedMs;
			set({
				isPaused: false,
				pendingAction: null,
				startedAtMs: Date.now() - base,
				elapsedMs: base,
			});
		} catch (err) {
			if (epoch !== recordingEpoch) {
				return;
			}
			// Stay paused so the user can retry; surface the reason.
			set({
				pendingAction: null,
				error:
					err instanceof Error ? err.message : "Failed to resume recording",
			});
		}
	},

	stop: async (target) => {
		if (get().sessionScope !== recordingScope(target)) {
			get().abandonRecording();
			return null;
		}
		const epoch = recordingEpoch;
		const { status, clipId, pendingAction } = get();
		if (status !== "recording" || !clipId || pendingAction) {
			return null;
		}
		set({ status: "stopping", error: null });
		try {
			const ctx = await stopClip(target, clipId);
			if (epoch !== recordingEpoch) {
				return null;
			}
			set({
				status: "idle",
				clipId: null,
				startedAtMs: null,
				elapsedMs: 0,
				isPaused: false,
				lastContext: ctx,
			});
			await get().refresh(target);
			return epoch === recordingEpoch ? ctx : null;
		} catch (err) {
			if (epoch !== recordingEpoch) {
				return null;
			}
			set({
				status: "recording",
				error: err instanceof Error ? err.message : "Failed to stop recording",
			});
			return null;
		}
	},

	tick: () => {
		const { startedAtMs, status, isPaused } = get();
		if (startedAtMs === null || status !== "recording" || isPaused) {
			return;
		}
		set({ elapsedMs: Date.now() - startedAtMs });
	},

	refresh: async (target) => {
		const epoch = recordingEpoch;
		try {
			const clips = await listClips(target);
			if (epoch === recordingEpoch) {
				set({ clips });
			}
		} catch {
			// A down node / sidecar just leaves the list unchanged - non-fatal.
		}
	},
}));

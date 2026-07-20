// apps/desktop/src/store/useClipStore.ts
//
// The recording state for Ryu Clips (agent-native Loom/Jam). Holds the live
// recorder status, capture-source toggles, the finished-clip list, and the last
// finalized context. The 1s elapsed-timer tick is DRIVEN BY the component
// (RecordingControls owns a `setInterval` and calls `tick()`), never by the
// store - a store must not own timers, so the effect can be cleaned up with the
// component's lifecycle. Pattern mirrors `useNodeStore` / `useMeetingRecordingStore`.

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

interface ClipState {
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
	refresh: (target: ApiTarget) => Promise<void>;
	/** Resume a paused recording; resyncs the timer to backend duration. */
	resume: (target: ApiTarget) => Promise<void>;
	setCaptureTarget: (target: ClipTarget) => void;
	setSource: (key: keyof ClipCaptureSources, value: boolean) => void;
	sources: ClipCaptureSources;
	start: (target: ApiTarget) => Promise<void>;
	startedAtMs: number | null;
	status: "idle" | "recording" | "stopping";
	stop: (target: ApiTarget) => Promise<ClipContext | null>;
	/** Recompute `elapsedMs` from the start stamp. Called by the component's timer. */
	tick: () => void;
}

export const useClipStore = create<ClipState>((set, get) => ({
	status: "idle",
	clipId: null,
	startedAtMs: null,
	elapsedMs: 0,
	isPaused: false,
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
		set({ status: "recording", error: null, elapsedMs: 0, isPaused: false });
		try {
			const ctx = await startClip(
				target,
				toStartOpts(get().sources, get().captureTarget)
			);
			set({ clipId: ctx.id, startedAtMs: Date.now(), elapsedMs: 0 });
		} catch (err) {
			set({
				status: "idle",
				clipId: null,
				startedAtMs: null,
				error: err instanceof Error ? err.message : "Failed to start recording",
			});
		}
	},

	pause: async (target) => {
		const { status, clipId, isPaused } = get();
		if (status !== "recording" || !clipId || isPaused) {
			return;
		}
		// Optimistic: freeze the timer immediately, revert if the backend rejects.
		set({ isPaused: true });
		try {
			const ctx = await pauseClip(target, clipId);
			const frozen =
				typeof ctx.durationMs === "number" ? ctx.durationMs : get().elapsedMs;
			set({ elapsedMs: frozen });
		} catch (err) {
			set({
				isPaused: false,
				error: err instanceof Error ? err.message : "Failed to pause recording",
			});
		}
	},

	resume: async (target) => {
		const { status, clipId, isPaused } = get();
		if (status !== "recording" || !clipId || !isPaused) {
			return;
		}
		try {
			const ctx = await resumeClip(target, clipId);
			// Re-anchor the start stamp so the tick continues from the backend's
			// duration (which excludes the paused span) rather than wall clock.
			const base =
				typeof ctx.durationMs === "number" ? ctx.durationMs : get().elapsedMs;
			set({ isPaused: false, startedAtMs: Date.now() - base, elapsedMs: base });
		} catch (err) {
			// Stay paused so the user can retry; surface the reason.
			set({
				error:
					err instanceof Error ? err.message : "Failed to resume recording",
			});
		}
	},

	stop: async (target) => {
		const { status, clipId } = get();
		if (status !== "recording" || !clipId) {
			return null;
		}
		set({ status: "stopping" });
		try {
			const ctx = await stopClip(target, clipId);
			set({
				status: "idle",
				clipId: null,
				startedAtMs: null,
				elapsedMs: 0,
				isPaused: false,
				lastContext: ctx,
			});
			await get().refresh(target);
			return ctx;
		} catch (err) {
			set({
				status: "idle",
				clipId: null,
				startedAtMs: null,
				elapsedMs: 0,
				isPaused: false,
				error: err instanceof Error ? err.message : "Failed to stop recording",
			});
			return null;
		}
	},

	tick: () => {
		const { startedAtMs } = get();
		if (startedAtMs === null) {
			return;
		}
		set({ elapsedMs: Date.now() - startedAtMs });
	},

	refresh: async (target) => {
		try {
			const clips = await listClips(target);
			set({ clips });
		} catch {
			// A down node / sidecar just leaves the list unchanged - non-fatal.
		}
	},
}));

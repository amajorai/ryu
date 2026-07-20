// apps/desktop/src/store/useDownloadsStore.ts
//
// Client mirror of Core's global download center. A single SSE subscription
// (see useDownloadsStream) feeds snapshots + deltas into this store; every
// surface (the app-wide download pill/panel, Store install buttons) reads from
// here so there is one client-side source of truth, matching Core's one
// server-side source of truth.

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
	type DownloadKind,
	type DownloadState,
	type DownloadTask,
	isInFlight,
} from "@/src/lib/api/downloads.ts";

interface DownloadsState {
	/** Replace the whole set (snapshot-on-connect). */
	applySnapshot: (tasks: DownloadTask[]) => void;
	/** Upsert one task (a live delta). */
	applyUpdate: (task: DownloadTask) => void;
	/** Drop one task (cleared/dismissed server-side). */
	removeTask: (id: string) => void;
	/** Clear the local mirror (e.g. on node switch before re-subscribing). */
	reset: () => void;
	/** All tracked downloads, keyed by id. */
	tasks: Record<string, DownloadTask>;
}

export const useDownloadsStore = create<DownloadsState>((set) => ({
	tasks: {},
	applySnapshot: (tasks) =>
		set(() => ({
			tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
		})),
	applyUpdate: (task) =>
		set((s) => ({ tasks: { ...s.tasks, [task.id]: task } })),
	removeTask: (id) =>
		set((s) => {
			const next = { ...s.tasks };
			delete next[id];
			return { tasks: next };
		}),
	reset: () => set(() => ({ tasks: {} })),
}));

/** Tasks as a list, newest first. */
export function selectOrderedTasks(s: DownloadsState): DownloadTask[] {
	return Object.values(s.tasks).sort((a, b) => b.created_at - a.created_at);
}

/** Aggregate the desktop pill renders: how many are running and overall %. */
export interface DownloadsAggregate {
	/** Tasks needing attention (failed). */
	failed: number;
	/** Any non-terminal or recently-finished task worth showing the pill for. */
	hasAny: boolean;
	/** Tasks still queued/active/verifying. */
	inFlight: number;
	/** Combined percent across in-flight tasks with a known size, or null. */
	percent: number | null;
}

const ACTIVE_STATES: DownloadState[] = [
	"queued",
	"active",
	"verifying",
	"paused",
];

// ── Per-install progress ────────────────────────────────────────────────────
//
// Catalog install buttons want the live percent of *their* download so they can
// render as a progress bar. The downloads store is keyed by opaque task id, but
// each task carries a human `label` (e.g. "unsloth/gemma-4 (model.gguf)") and a
// `kind`. We match a button to its task by artifact kind + a normalized name
// hint taken from the label, falling back to the sole in-flight task of that
// kind when no name matches. Purely cosmetic — it never gates the install.

/** Live progress for one install, as a catalog button consumes it. */
export interface InstallProgress {
	/** A matching download is in flight (queued/active/verifying/paused). */
	active: boolean;
	/** Completion 0–100 when the size is known, else null (indeterminate). */
	percent: number | null;
}

/** Strip everything but a–z0–9 so "whispercpp" matches a "whisper.cpp" label. */
function normalizeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A download still occupying (or holding) a slot — worth showing progress for. */
function isTrackable(state: DownloadState): boolean {
	return isInFlight(state) || state === "paused";
}

/**
 * Build a selector for the live progress of an install identified by artifact
 * `kinds` + a `nameHint` (matched against the task label). Prefers a label-name
 * match; falls back to the single in-flight task of those kinds.
 */
export function selectInstallProgress(
	kinds: readonly DownloadKind[],
	nameHint: string
): (s: DownloadsState) => InstallProgress {
	const wanted = new Set(kinds);
	const hint = normalizeName(nameHint);
	return (s) => {
		const candidates = Object.values(s.tasks).filter(
			(t) => wanted.has(t.kind) && isTrackable(t.state)
		);
		if (candidates.length === 0) {
			return { active: false, percent: null };
		}
		const named = hint
			? candidates.find((t) => normalizeName(t.label).includes(hint))
			: undefined;
		const task = named ?? (candidates.length === 1 ? candidates[0] : undefined);
		if (!task) {
			return { active: false, percent: null };
		}
		const percent =
			task.total_bytes && task.total_bytes > 0
				? Math.min(100, (task.received_bytes / task.total_bytes) * 100)
				: null;
		return { active: true, percent };
	};
}

/**
 * Live progress for an install button. Pass the artifact kind(s) and a name hint
 * (the repo id, filename, engine/skill/agent name) found in the download label.
 */
export function useInstallProgress(
	kinds: readonly DownloadKind[],
	nameHint: string
): InstallProgress {
	return useDownloadsStore(useShallow(selectInstallProgress(kinds, nameHint)));
}

export function selectAggregate(s: DownloadsState): DownloadsAggregate {
	const tasks = Object.values(s.tasks);
	let inFlight = 0;
	let failed = 0;
	let received = 0;
	let total = 0;
	let haveSizes = false;
	for (const t of tasks) {
		if (isInFlight(t.state)) {
			inFlight += 1;
		}
		if (t.state === "failed") {
			failed += 1;
		}
		if (t.total_bytes && ACTIVE_STATES.includes(t.state)) {
			total += t.total_bytes;
			received += Math.min(t.received_bytes, t.total_bytes);
			haveSizes = true;
		}
	}
	const percent = haveSizes && total > 0 ? (received / total) * 100 : null;
	return {
		inFlight,
		failed,
		percent,
		hasAny: tasks.length > 0,
	};
}

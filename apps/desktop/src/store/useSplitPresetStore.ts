// apps/desktop/src/store/useSplitPresetStore.ts
//
// The user's saved pane layouts. Named, id-free SHAPES (see
// `lib/splitPresets.ts`) — never a live split, whose leaves are session-scoped
// tab ids.
//
// Persisted to localStorage under `ryu_split_presets`, the same hand-rolled
// read-on-boot / write-on-change idiom the other desktop collections use
// (`ryu_custom_themes`, `ryu_pinned_dock_tabs`). NOT Core's preference store:
// nothing outside this window renders panes, so the cross-process channel would
// buy nothing and add a round-trip plus an offline failure mode to a purely
// local UI affordance. The live layout (`ryu_session_tabs`) stays machine-local;
// only these named shapes are portable enough to ride settings sync.

import { create } from "zustand";
import {
	MAX_NAME_LENGTH,
	MAX_PRESETS,
	type PresetBranch,
	parsePresets,
	type SplitPreset,
} from "@/src/lib/splitPresets.ts";

export const SPLIT_PRESETS_KEY = "ryu_split_presets";

function load(): SplitPreset[] {
	try {
		const raw = localStorage.getItem(SPLIT_PRESETS_KEY);
		return raw ? parsePresets(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

function persist(presets: SplitPreset[]) {
	// Publish only after storage acknowledges the write. A refusal leaves both
	// the previous collection and the caller's draft available for a retry.
	if (presets.length === 0) {
		localStorage.removeItem(SPLIT_PRESETS_KEY);
		return;
	}
	localStorage.setItem(SPLIT_PRESETS_KEY, JSON.stringify(presets));
}

function makePresetId(): string {
	return `preset-${crypto.randomUUID()}`;
}

interface SplitPresetState {
	deletePreset: (id: string) => void;
	presets: SplitPreset[];
	/** Re-read the persisted collection. Settings sync writes the key straight
	    into localStorage and broadcasts nothing (same as `ryu_custom_themes`,
	    which re-reads on demand), so a collection that arrived from another
	    machine is picked up when the manager UI mounts rather than by an event. */
	reload: () => void;
	renamePreset: (id: string, name: string) => void;
	/** Store a new named shape; returns it (or null when the name is blank or
	    a new name would exceed the collection limit). */
	savePreset: (name: string, root: PresetBranch) => SplitPreset | null;
}

export const useSplitPresetStore = create<SplitPresetState>((set, get) => ({
	presets: load(),

	savePreset: (name, root) => {
		const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
		const existing = get().presets;
		const replacesName = existing.some(
			(preset) => preset.name.toLowerCase() === trimmed.toLowerCase()
		);
		if (!trimmed || (existing.length >= MAX_PRESETS && !replacesName)) {
			return null;
		}
		const preset: SplitPreset = {
			id: makePresetId(),
			name: trimmed,
			root,
			createdAt: Date.now(),
		};
		set((state) => {
			// Saving under an existing name replaces that preset rather than
			// stacking a second row the user cannot tell apart.
			const presets = [
				...state.presets.filter(
					(p) => p.name.toLowerCase() !== trimmed.toLowerCase()
				),
				preset,
			];
			persist(presets);
			return { presets };
		});
		return preset;
	},

	renamePreset: (id, name) => {
		const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
		if (!trimmed) {
			return;
		}
		set((state) => {
			const presets = state.presets.map((p) =>
				p.id === id ? { ...p, name: trimmed } : p
			);
			persist(presets);
			return { presets };
		});
	},

	deletePreset: (id) => {
		set((state) => {
			const presets = state.presets.filter((p) => p.id !== id);
			persist(presets);
			return { presets };
		});
	},

	reload: () => {
		set({ presets: load() });
	},
}));

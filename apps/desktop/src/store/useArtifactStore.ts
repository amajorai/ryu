// apps/desktop/src/store/useArtifactStore.ts
//
// The in-memory home for artifacts opened as WORKSPACE (window) tabs. A window
// tab addresses an artifact by path (`/artifact/<id>`); the id is only stable
// for the session, so a tab opened on one and restored later resolves to
// nothing and the page says so — the same "no longer available" contract the
// dock's artifact tab already uses. Artifacts here are minted by the agent's
// inline artifact surface before the tab opens, so `put` always precedes
// `openTab("/artifact/...")`.

import { create } from "zustand";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";

interface ArtifactStoreState {
	/** Artifacts by id, most-recently-put wins (a re-render of the same artifact
	 *  replaces rather than stacks). */
	artifacts: Record<string, ArtifactView>;
	get: (id: string) => ArtifactView | undefined;
	put: (artifact: ArtifactView) => void;
}

export const useArtifactStore = create<ArtifactStoreState>((set, get) => ({
	artifacts: {},
	get: (id) => get().artifacts[id],
	put: (artifact) =>
		set((state) => ({
			artifacts: { ...state.artifacts, [artifact.id]: artifact },
		})),
}));

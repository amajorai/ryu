import type React from "react";
import { createContext, useContext } from "react";
import type { NativeArtifactObservation } from "./native-artifact-observation.ts";

/**
 * A serializable artifact as the agent's tool delivers it (`artifact.render` /
 * `artifact.create`). Kept loose so a newer Core can add fields without breaking
 * an older shell; `packages/blocks` never interprets it beyond passing it through
 * to the desktop renderer.
 */
export interface HostArtifactAction {
	id: string;
	label: string;
	tone?: "primary" | "secondary" | "ghost";
}

export interface HostArtifact {
	actions?: HostArtifactAction[];
	content?: string;
	docId?: string;
	filePath?: string;
	kind?: string;
	language?: string;
	mime?: string;
	spaceId?: string;
	title?: string;
	url?: string;
}

/**
 * The desktop-injected surface an inline artifact tool part renders through —
 * the same pattern as the widget host. `packages/blocks` renders the part, the
 * desktop owns the actual artifact card (it holds the Artifact model, the
 * sandboxed viewer and the node token needed to fetch a created artifact's
 * blob). Without a host, an artifact part degrades to a plain tool row.
 */
export interface ArtifactHostValue {
	/** Resolve a created artifact's content by fetching its blob URL (uses the
	 *  host's node target). Returns null when the artifact carries no URL or the
	 *  fetch failed — the surface then shows the download/open affordance. */
	fetchContent(
		payload: NativeArtifactObservation,
		id: string
	): Promise<string | null>;
	/** Open the artifact in the workspace's right dock (a dedicated artifact tab). */
	openInPanel(payload: NativeArtifactObservation, id: string): void;
	/** Open the artifact as its own window (workspace) tab. */
	openInTab(payload: NativeArtifactObservation, id: string): void;
	/** The concrete artifact card, injected by apps/desktop. */
	Renderer: React.ComponentType<{
		artifact: NativeArtifactObservation;
		id: string;
	}>;
	/** Send a follow-up user turn to the conversation (used by approval-style
	 *  artifact actions — the user's choice becomes the agent's next prompt). */
	submitFollowUp(text: string): void;
}

const ArtifactHostContext = createContext<ArtifactHostValue | null>(null);

export { ArtifactHostContext };

/** Read the injected artifact host, or `null` when none is mounted (artifact
 *  parts then degrade to a plain tool row). */
export function useArtifactHost(): ArtifactHostValue | null {
	return useContext(ArtifactHostContext);
}

export type { NativeArtifactObservation } from "./native-artifact-observation.ts";

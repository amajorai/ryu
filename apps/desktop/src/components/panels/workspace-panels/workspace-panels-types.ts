import type { ReactNode } from "react";
import type { ContextPanelView } from "@/src/components/panels/ContextPanel.tsx";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import type { FileTreeSearchRequest } from "@/src/store/useFileTreeSearchStore.ts";
import type { CoworkData } from "./native-dock-panels.tsx";
import type { FileReviewRequest } from "./patch-diff-panel.tsx";

export interface WorkspacePanelsProps {
	/** Whether this chat has an individual agent whose profile can be opened. */
	agentActivityAvailable?: boolean;
	/** Current chat agent's profile and activity content. */
	agentActivityPanel?: ReactNode | null;
	/** Request to focus this chat's agent activity tab in the right dock. */
	agentActivityRequest?: { nonce: number } | null;
	/**
	 * A request to open a rendered/canvas artifact in the right panel. Like
	 * `subagentRequest`, the `nonce` changes on every click so re-selecting the
	 * same artifact re-focuses the tab. Null when nothing has been requested.
	 */
	artifactRequest?: { artifact: ArtifactView; nonce: number } | null;
	bottomOpen: boolean;
	children: ReactNode;
	/** Open a complete run collection from its capped pinned-summary section. */
	collectionRequest?: {
		kind: "sources" | "subagents";
		nonce: number;
	} | null;
	/**
	 * A request to open the context-window breakdown in the right panel. Carries
	 * only a `nonce` — the DATA is `contextView`, passed live, so the panel keeps
	 * tracking the conversation instead of freezing at the moment it was opened.
	 */
	contextRequest?: { nonce: number } | null;
	/** Live inputs for the context breakdown tab (conversation, target, usage). */
	contextView?: ContextPanelView | null;
	/** Chat-specific data for the Context (cowork) right-panel tab. */
	cowork?: CoworkData;
	/** Opens a path-scoped Changes view for one completed assistant turn. */
	fileReviewRequest?: FileReviewRequest | null;
	/** Request from the focused chat to open and drive the Files tree search. */
	fileSearchRequest?: FileTreeSearchRequest | null;
	folder?: string | null;
	/**
	 * A request to inspect a raw message part (tool call / image / citations) in
	 * the right panel's PartInspector. Like `artifactRequest`, the `nonce` changes
	 * on every click so re-inspecting refreshes the same reusable tab. Null when
	 * nothing has been requested.
	 */
	inspectorRequest?: { part: unknown; nonce: number } | null;
	onBottomOpenChange: (v: boolean) => void;
	onRightOpenChange: (v: boolean) => void;
	/**
	 * Chat's Pinned summary sidebar. When provided it docks as its own column
	 * stacked against (left of) the right panel — both push the chat narrower,
	 * shadcn-sidebar style, and both can be open at once. When the chat column
	 * would drop below a usable width the panel auto-demotes to a floating
	 * overlay that no longer affects content width; `floating` tells the
	 * renderer which mode it is in (only the floating overlay should dismiss
	 * on press-away). Null/undefined = hidden.
	 */
	renderPinnedSummary?: ((opts: { floating: boolean }) => ReactNode) | null;
	rightOpen: boolean;
	/**
	 * A request to open a spawned subagent's transcript in the right panel. Its
	 * `nonce` changes on every click so re-selecting the same subagent re-focuses
	 * the tab. Null when nothing has been requested.
	 */
	subagentRequest?: { id: string; nonce: number } | null;
}

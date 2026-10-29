"use client";

import type { RefObject } from "react";
import { AssistantPanel } from "./assistant-panel.tsx";
import type { AssistantMode } from "./runtime-controls.tsx";
import { useAssistantSession } from "./use-assistant-session.ts";
import { usePageContext } from "./use-page-context.ts";
import type { WebMcpPageToolsState } from "./webmcp.ts";

export interface AssistantSessionProps {
	contextRootRef: RefObject<HTMLDivElement | null>;
	docsBaseUrl?: string;
	initialMode: AssistantMode;
	onClose?: () => void;
	open: boolean;
	pageTools: WebMcpPageToolsState;
	poweredByRyu: boolean;
	selection: string | null;
}

/**
 * Everything behind the launcher: chat state, runtimes, page context and the
 * shared chat surface. This module is its own chunk, loaded on first open.
 */
export function AssistantSession({
	contextRootRef,
	docsBaseUrl,
	initialMode,
	onClose,
	open,
	pageTools,
	poweredByRyu,
	selection,
}: AssistantSessionProps) {
	const page = usePageContext({ contextRootRef, open, selection });
	const panel = useAssistantSession({
		capturePage: page.capture,
		docsBaseUrl,
		initialMode,
	});
	return (
		<AssistantPanel
			{...panel}
			browserContext={page.context}
			onClose={onClose}
			pageTools={pageTools}
			poweredByRyu={poweredByRyu}
		/>
	);
}

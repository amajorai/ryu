"use client";

import { PoweredByRyuBadge } from "@ryu/ui/components/powered-by-ryu.tsx";
import type { ChatStatus, UIMessage } from "ai";
import type { BrowserPageContext } from "./browser-context.ts";
import { RyuAssistantChat } from "./chat.tsx";
import type { LocalNodeHealth } from "./local-node.ts";
import { PageContextChips } from "./page-context.tsx";
import { PageToolsPopover } from "./page-tools.tsx";
import {
	type AssistantMode,
	RuntimeSettings,
	RuntimeSetupPrompt,
	type RuntimeSetupProps,
} from "./runtime-controls.tsx";
import { nodeSummary } from "./session-helpers.ts";
import type { WebMcpPageTool, WebMcpPageToolsState } from "./webmcp.ts";

export interface AssistantPanelProps extends RuntimeSetupProps {
	browserContext: BrowserPageContext;
	guestAvailable: boolean;
	includePageContext: boolean;
	includeSelectionContext: boolean;
	infoBar?: {
		description?: string;
		onClose?: () => void;
		variant?: "default" | "destructive";
	};
	messages: UIMessage[];
	nodeConnected: boolean;
	nodeHealth: LocalNodeHealth | undefined;
	onClose?: () => void;
	onDisconnect: () => void;
	onIncludePageContextChange: (value: boolean) => void;
	onIncludeSelectionContextChange: (value: boolean) => void;
	onModeChange: (mode: AssistantMode) => void;
	onPageToolResult: (tool: WebMcpPageTool, result: string) => void;
	onSend: (message: { content: string; role: "user" }) => void;
	onStop: () => void;
	pageTools: WebMcpPageToolsState;
	poweredByRyu: boolean;
	status: ChatStatus;
	title: string;
}

/**
 * The public assistant body: the same `RyuAssistantChat` floating surface Desktop
 * renders (quiet title row, transcript, minimal composer). Public-only concerns —
 * runtime choice, setup, and page context — use Desktop's slots for the same jobs:
 * the header settings button, the composer prompt, and composer context chips.
 * Where prompts go is said once, in each runtime's description in the settings
 * popover, rather than in a footer under every conversation. Errors arrive as
 * one sentence in the info bar (with Retry and Copy details), never as raw text.
 */
export function AssistantPanel({
	browserContext,
	includePageContext,
	includeSelectionContext,
	infoBar,
	messages,
	nodeConnected,
	nodeHealth,
	onClose,
	onDisconnect,
	onIncludePageContextChange,
	onIncludeSelectionContextChange,
	guestAvailable,
	onModeChange,
	onPageToolResult,
	onSend,
	onStop,
	pageTools,
	poweredByRyu,
	status,
	title,
	...setupProps
}: AssistantPanelProps) {
	const { browserStatus, busy, mode } = setupProps;
	const runtimeReady =
		mode === "guest" ||
		(mode === "browser" && browserStatus?.status === "ready") ||
		(mode === "node" && nodeConnected);
	// Guest turns carry only the question; page text stays local or on the
	// visitor's own node, so the context chips appear only for those runtimes.
	const showPageContext = runtimeReady && mode !== "guest";

	return (
		<RyuAssistantChat
			actions={
				<>
					<PageToolsPopover
						onExecute={(tool, input) => pageTools.execute(tool.id, input)}
						onResult={onPageToolResult}
						tools={pageTools.tools}
					/>
					<RuntimeSettings
						busy={busy}
						guestAvailable={guestAvailable}
						mode={mode}
						nodeConnected={nodeConnected}
						nodeSummary={nodeHealth ? nodeSummary(nodeHealth) : undefined}
						onDisconnect={onDisconnect}
						onModeChange={onModeChange}
					/>
				</>
			}
			allowResponseImages={false}
			composerDisabled={busy || !runtimeReady}
			composerHeader={
				showPageContext ? (
					<PageContextChips
						context={browserContext}
						includePage={includePageContext}
						includeSelection={includeSelectionContext}
						onIncludePageChange={onIncludePageContextChange}
						onIncludeSelectionChange={onIncludeSelectionContextChange}
					/>
				) : undefined
			}
			composerPrompt={
				runtimeReady
					? undefined
					: {
							content: <RuntimeSetupPrompt {...setupProps} />,
							id: `runtime-setup:${mode}`,
						}
			}
			footer={
				poweredByRyu ? (
					<div className="flex shrink-0 justify-center px-4 pb-2">
						<PoweredByRyuBadge source="assistant-widget" />
					</div>
				) : undefined
			}
			infoBar={infoBar}
			messages={messages}
			onClose={onClose}
			onSend={onSend}
			onStop={onStop}
			placement="floating"
			showCopyToolbar
			status={status}
			title={title}
		/>
	);
}

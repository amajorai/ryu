// apps/desktop/src/components/chat/WorkspaceBar.tsx
//
// The composer workspace strip (project folder ▸ run location ▸ git branch): the row
// of borderless chips that sit in the composer's bottom bar (the info-bar-style
// footer shell rendered by InputBar's `workspaceBar` slot). Each segment is a
// click-to-change popover. The branch and worktree segments render only for a
// git-repo folder, so for a plain folder (or none) the row collapses to just the
// project picker. The bar shell (height, padding, muted surface, rounded bottom)
// is owned by InputBar; this component renders only the chips.
//
// The computer chip leads the row. The launchpad drives it through `computer`
// (no tab exists yet); inside a chat tab it reads and writes the tab's own
// computer binding, and locks once the chat has a message.
//
// A normal (non-cloud) chat whose computer use or sub-agents started a session
// Box also shows that Box's cost, screen action and credit warnings here.

import type { ReactNode } from "react";
import { useCurrentTabId } from "@/src/contexts/TabsContext.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { CloudTaskSelection } from "@/src/lib/cloud-task-selection.ts";
import { CloudEnvironmentPicker } from "./CloudEnvironmentPicker.tsx";
import { CloudTaskBackendChooser } from "./CloudTaskBackendChooser.tsx";
import { CloudTaskPanel } from "./CloudTaskPanel.tsx";
import {
	ComputerChip,
	type ComputerChipProps,
	TabComputerChip,
} from "./ComputerChip.tsx";
import { SessionBoxStrip } from "./SessionBoxStrip.tsx";
import { SubscriptionRunPanel } from "./SubscriptionRunPanel.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

interface WorkspaceBarProps {
	cloudBlockReason?: string | null;
	cloudScope?: string | null;
	cloudSelection?: CloudTaskSelection;
	/** The persisted conversation a locked cloud chat runs in; shows the task panel. */
	cloudTaskConversationId?: string | null;
	/** Drive the computer chip directly (the launchpad, before a tab exists).
	 *  Absent inside a chat tab: the chip follows the tab's own binding. */
	computer?: ComputerChipProps;
	conversationId?: string | null;
	folderOverride?: string | null;
	onCloudRetry?: () => void;
	/** Called when a cloud run or finish settles, so the chat reloads Core's messages. */
	onCloudRunSettled?: () => void;
	onWorktreeModeChange?: (enabled: boolean) => void;
	target: ApiTarget;
	worktreeModeOverride?: boolean;
}

export function WorkspaceBar({
	cloudScope,
	cloudSelection,
	onCloudRetry,
	onCloudRunSettled,
	cloudBlockReason,
	computer,
	cloudTaskConversationId,
	conversationId,
	folderOverride,
	onWorktreeModeChange,
	target,
	worktreeModeOverride,
}: WorkspaceBarProps) {
	const tabId = useCurrentTabId();
	let computerChip: ReactNode = null;
	if (computer) {
		computerChip = <ComputerChip {...computer} />;
	} else if (tabId) {
		computerChip = (
			<TabComputerChip conversationId={conversationId} tabId={tabId} />
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-1">
			{computerChip}
			{cloudSelection?.mode === "cloud" ? null : (
				<WorkspacePicker
					conversationId={conversationId}
					folderOverride={folderOverride}
					onWorktreeModeChange={onWorktreeModeChange}
					target={target}
					worktreeModeOverride={worktreeModeOverride}
				/>
			)}
			{cloudSelection ? (
				<CloudEnvironmentPicker
					key={cloudScope ?? "loading"}
					onRetry={onCloudRetry}
					scope={cloudScope ?? null}
					selection={cloudSelection}
					target={target}
				/>
			) : null}
			{cloudSelection?.mode === "cloud" &&
			!cloudSelection.locked &&
			cloudScope &&
			cloudSelection.runtime &&
			(cloudSelection.runtime.executor === "claude-code" ||
				cloudSelection.runtime.executor === "codex") ? (
				<CloudTaskBackendChooser
					executor={cloudSelection.runtime.executor}
					scope={cloudScope}
					target={target}
				/>
			) : null}
			{cloudSelection?.mode === "cloud" &&
			cloudSelection.locked &&
			cloudTaskConversationId ? (
				<SubscriptionRunPanel
					conversationId={cloudTaskConversationId}
					key={`plan:${target.url}:${cloudTaskConversationId}`}
					target={target}
				/>
			) : null}
			{cloudSelection?.mode === "cloud" &&
			cloudSelection.locked &&
			cloudTaskConversationId ? (
				<CloudTaskPanel
					conversationId={cloudTaskConversationId}
					key={`${target.url}:${cloudTaskConversationId}`}
					onRunSettled={onCloudRunSettled}
					target={target}
				/>
			) : null}
			{cloudSelection?.mode !== "cloud" && conversationId ? (
				<SessionBoxStrip
					conversationId={conversationId}
					key={`${target.url}:${conversationId}`}
					target={target}
				/>
			) : null}
			{cloudSelection?.mode === "cloud" && cloudBlockReason ? (
				<p className="text-muted-foreground text-xs" role="status">
					{cloudBlockReason}
				</p>
			) : null}
		</div>
	);
}

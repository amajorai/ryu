// apps/desktop/src/components/chat/WorkspaceBar.tsx
//
// The composer workspace strip (project folder ▸ run location ▸ git branch): the row
// of borderless chips that sit in the composer's bottom bar (the info-bar-style
// footer shell rendered by InputBar's `workspaceBar` slot). Each segment is a
// click-to-change popover. The branch and worktree segments render only for a
// git-repo folder, so for a plain folder (or none) the row collapses to just the
// project picker. The bar shell (height, padding, muted surface, rounded bottom)
// is owned by InputBar; this component renders only the chips.

import type { ApiTarget } from "@/src/lib/api/client.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

interface WorkspaceBarProps {
	conversationId?: string | null;
	folderOverride?: string | null;
	onWorktreeModeChange?: (enabled: boolean) => void;
	target: ApiTarget;
	worktreeModeOverride?: boolean;
}

export function WorkspaceBar({
	conversationId,
	folderOverride,
	onWorktreeModeChange,
	target,
	worktreeModeOverride,
}: WorkspaceBarProps) {
	return (
		<WorkspacePicker
			conversationId={conversationId}
			folderOverride={folderOverride}
			onWorktreeModeChange={onWorktreeModeChange}
			target={target}
			worktreeModeOverride={worktreeModeOverride}
		/>
	);
}

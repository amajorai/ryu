// apps/desktop/src/components/chat/WorkspacePicker-run-mode.tsx
//
// WorkspacePicker's run-location body: local folder vs. a new Git worktree.

import {
	FolderTreeIcon,
	LaptopIcon,
	RefreshIcon,
	type WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	CommandGroup,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/command.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { WorktreeStatus } from "@/src/lib/api/git.ts";

export function RunModeContent({
	status,
	worktreeMode,
	worktreeBranch,
	onClose,
	onSetMode,
	onSetBranch,
	onRegenerate,
}: {
	status: WorktreeStatus;
	worktreeMode: boolean;
	worktreeBranch: string;
	onClose: () => void;
	onSetMode: (v: boolean) => void;
	onSetBranch: (v: string) => void;
	onRegenerate: () => void;
}) {
	const tl = useLiteralMessages();
	if (status.active) {
		// Informational only, so it sits outside a listbox that would expect
		// options.
		return (
			<div className="flex flex-col gap-2 px-2 py-2">
				<div className="flex items-center gap-2 px-1">
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={FolderTreeIcon}
					/>
					<span
						className="min-w-0 flex-1 truncate"
						title={status.branch ?? undefined}
					>
						{status.branch}
					</span>
				</div>
				<p className="px-1 text-muted-foreground text-xs">
					{status.changed_files > 0
						? tl(
								"{changedFiles, plural, one {{fileCount} changed file. Review and apply from the diff panel.} other {{fileCount} changed files. Review and apply from the diff panel.}}",
								{
									changedFiles: status.changed_files,
									fileCount: formatCount(status.changed_files),
								}
							)
						: "This chat runs in its own worktree. Changes are isolated until you apply them from the diff panel."}
				</p>
			</div>
		);
	}
	const selectMode = (enabled: boolean) => {
		onSetMode(enabled);
		onClose();
	};
	return (
		<CommandList>
			<CommandGroup heading="Work in">
				<ModeRow
					icon={LaptopIcon}
					onSelect={() => selectMode(false)}
					selected={!worktreeMode}
					title="Local"
				/>
				<ModeRow
					icon={FolderTreeIcon}
					onSelect={() => selectMode(true)}
					selected={worktreeMode}
					title="New worktree"
				/>
			</CommandGroup>
			{worktreeMode && (
				<div className="flex flex-col gap-1.5 px-2.5 pb-2">
					<span className="type-caption text-muted-foreground">
						Branch name
					</span>
					<div className="flex items-center gap-1.5">
						<Input
							aria-label="Branch name"
							className="flex-1"
							onChange={(e) => onSetBranch(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							placeholder="ryu/my-feature"
							purpose="picker-code-value"
							spellCheck={false}
							value={worktreeBranch}
							variant="code"
						/>
						<Button
							aria-label="Suggest a new branch name"
							className="size-7 shrink-0"
							onClick={onRegenerate}
							size="icon"
							title="Suggest a new name"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={RefreshIcon} />
						</Button>
					</div>
				</div>
			)}
		</CommandList>
	);
}

function ModeRow({
	title,
	icon,
	selected,
	onSelect,
}: {
	title: string;
	icon: typeof WorkflowCircle06Icon;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<CommandItem
			data-checked={selected}
			onSelect={onSelect}
			value={`mode:${title}`}
		>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={icon}
			/>
			<span className="min-w-0 flex-1 truncate">{title}</span>
		</CommandItem>
	);
}

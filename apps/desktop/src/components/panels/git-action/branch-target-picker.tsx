// The commit dialog's branch target picker and diff stats, split out of
// apps/desktop/src/components/panels/GitActionDialogs.tsx so that file stays
// under the size limit.

import {
	Add01Icon,
	ArrowDown01Icon,
	GitBranchIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";

export function DialogDiffStats({
	deletions,
	insertions,
}: {
	deletions: number;
	insertions: number;
}) {
	if (insertions === 0 && deletions === 0) {
		return null;
	}
	return (
		<span className="col-start-2 flex shrink-0 items-center gap-2 text-xs tabular-nums sm:col-start-auto">
			{insertions > 0 && (
				<span className="text-status-success">+{formatCount(insertions)}</span>
			)}
			{deletions > 0 && (
				<span className="text-status-destructive">
					−{formatCount(deletions)}
				</span>
			)}
		</span>
	);
}

interface BranchTargetPickerProps {
	branch: string;
	branches: string[];
	disabled: boolean;
	loading: boolean;
	onBranchMenuOpenChange: (open: boolean) => void;
	onCreateBranch?: (name: string) => Promise<string | null>;
	onSelectBranch: (branch: string) => void;
}

export function BranchTargetPicker({
	branch,
	branches,
	disabled,
	loading,
	onBranchMenuOpenChange,
	onCreateBranch,
	onSelectBranch,
}: BranchTargetPickerProps) {
	const tl = useLiteralMessages();
	const [newBranchOpen, setNewBranchOpen] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const [newBranchError, setNewBranchError] = useState<string | null>(null);
	const branchOptions = [
		branch,
		...branches.filter((candidate) => candidate !== branch),
	].filter(Boolean);

	const handleCreateBranch = async () => {
		const name = newBranchName.trim();
		if (!(name && onCreateBranch)) {
			return;
		}
		setNewBranchError(null);
		const error = await onCreateBranch(name);
		if (error) {
			setNewBranchError(error);
			return;
		}
		setNewBranchName("");
		setNewBranchOpen(false);
	};

	return (
		<>
			<DropdownMenu onOpenChange={onBranchMenuOpenChange}>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label={tl("Commit to {branch}", { branch })}
							className="w-full justify-start"
							disabled={disabled}
							type="button"
							variant="secondary"
						/>
					}
				>
					<HugeiconsIcon
						aria-hidden
						className="size-4 shrink-0"
						icon={GitBranchIcon}
					/>
					<ButtonLabel className="min-w-0 flex-1 text-left">
						{branch}
					</ButtonLabel>
					<HugeiconsIcon
						aria-hidden
						className="size-4 shrink-0"
						icon={ArrowDown01Icon}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-72 max-w-[calc(100vw-2rem)]"
					sideOffset={8}
				>
					<DropdownMenuGroup>
						<DropdownMenuLabel>Commit to</DropdownMenuLabel>
						{loading ? (
							<SkeletonRows
								inset="panel-horizontal"
								label="Loading branches…"
								size="sm"
								spacing="compact-stack"
							/>
						) : (
							branchOptions.map((candidate) => (
								<DropdownMenuItem
									disabled={disabled}
									key={candidate}
									onClick={() => onSelectBranch(candidate)}
								>
									<HugeiconsIcon
										aria-hidden
										className="size-4 shrink-0 text-muted-foreground"
										icon={GitBranchIcon}
									/>
									<span className="min-w-0 flex-1 truncate" title={candidate}>
										{candidate}
									</span>
									{candidate === branch && (
										<HugeiconsIcon
											aria-hidden
											className="size-4 shrink-0"
											icon={Tick02Icon}
										/>
									)}
								</DropdownMenuItem>
							))
						)}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={disabled || !onCreateBranch}
						onClick={() => setNewBranchOpen(true)}
					>
						<HugeiconsIcon
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground"
							icon={Add01Icon}
						/>
						New branch
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog
				onOpenChange={(open) => {
					setNewBranchOpen(open);
					if (!open) {
						setNewBranchError(null);
					}
				}}
				open={newBranchOpen}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>New branch</DialogTitle>
						<DialogDescription>
							Create a branch from the current commit and switch to it.
						</DialogDescription>
					</DialogHeader>
					<Input
						aria-label="New branch name"
						onChange={(event) => {
							setNewBranchName(event.target.value);
							setNewBranchError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void handleCreateBranch();
							}
						}}
						placeholder="feature/my-branch"
						spellCheck={false}
						value={newBranchName}
					/>
					{newBranchError && (
						<p className="text-status-destructive text-xs">{newBranchError}</p>
					)}
					<div className="flex justify-end gap-2">
						<Button
							onClick={() => setNewBranchOpen(false)}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							disabled={!newBranchName.trim()}
							onClick={() => void handleCreateBranch()}
							type="button"
						>
							Create branch
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

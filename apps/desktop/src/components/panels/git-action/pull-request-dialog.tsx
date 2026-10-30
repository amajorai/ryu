// The pull-request dialog, split out of
// apps/desktop/src/components/panels/GitActionDialogs.tsx (which re-exports it)
// so that file stays under the size limit.

import { ArrowUpRight01Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type {
	GitProgressPhase,
	PullRequestAction,
} from "../GitActionDialogs.tsx";
import { DialogDiffStats } from "./branch-target-picker.tsx";

const PULL_REQUEST_ACTIONS: ReadonlyArray<{
	action: PullRequestAction;
	icon: typeof Share08Icon;
	label: string;
}> = [
	{ action: "draft", icon: Share08Icon, label: "Create draft PR" },
	{ action: "create", icon: Share08Icon, label: "Create PR" },
	{ action: "open", icon: ArrowUpRight01Icon, label: "Open PR in browser" },
];

export interface PullRequestDialogProps {
	baseBranch: string;
	branch: string;
	deletions: number;
	description: string;
	error?: string | null;
	includeUnstaged: boolean;
	insertions: number;
	onDescriptionChange: (description: string) => void;
	onIncludeUnstagedChange: (include: boolean) => void;
	onOpenChange: (open: boolean) => void;
	onSubmit: (action: PullRequestAction) => void;
	onTitleChange: (title: string) => void;
	open: boolean;
	progress?: GitProgressPhase;
	title: string;
}

export function PullRequestDialog({
	baseBranch,
	branch,
	deletions,
	description,
	error,
	includeUnstaged,
	insertions,
	onDescriptionChange,
	onIncludeUnstagedChange,
	onOpenChange,
	onSubmit,
	onTitleChange,
	open,
	progress,
	title,
}: PullRequestDialogProps) {
	const busy = progress !== undefined;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Create pull request</DialogTitle>
					<DialogDescription className="break-all">
						{branch} → {baseBranch}
					</DialogDescription>
				</DialogHeader>
				<Input
					aria-label="Pull request title"
					disabled={busy}
					onChange={(event) => onTitleChange(event.target.value)}
					placeholder="Title"
					value={title}
				/>
				<Textarea
					aria-label="Pull request description"
					className="max-h-60 min-h-28"
					disabled={busy}
					onChange={(event) => onDescriptionChange(event.target.value)}
					placeholder="Description (leave empty to generate)"
					value={description}
				/>
				<label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto]">
					<Checkbox
						checked={includeUnstaged}
						disabled={busy}
						onCheckedChange={(checked) =>
							onIncludeUnstagedChange(checked === true)
						}
					/>
					<span className="min-w-0 flex-1">Commit and push local changes</span>
					<DialogDiffStats deletions={deletions} insertions={insertions} />
				</label>
				{error && (
					<p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
						{error}
					</p>
				)}
				<div className="grid gap-2 border-border border-t pt-4">
					{PULL_REQUEST_ACTIONS.map((item, index) => (
						<Button
							className="w-full justify-start"
							disabled={busy}
							key={item.action}
							onClick={() => onSubmit(item.action)}
							type="button"
							variant={index === 1 ? "secondary" : "ghost"}
						>
							<HugeiconsIcon
								aria-hidden
								className="size-4 shrink-0 text-muted-foreground"
								icon={item.icon}
							/>
							<ButtonLabel className="min-w-0 flex-1 text-left">
								{item.label}
							</ButtonLabel>
						</Button>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}

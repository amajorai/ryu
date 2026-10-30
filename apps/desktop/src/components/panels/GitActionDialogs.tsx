import {
	ArrowDown01Icon,
	CloudUploadIcon,
	GitCommitIcon,
	Globe02Icon,
	Loading01Icon,
	RefreshIcon,
	SquareLock01Icon,
	StopIcon,
} from "@hugeicons/core-free-icons";
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
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { GitCommitAction } from "@/src/lib/api/git.ts";
import type { GitHubRepositoryVisibility } from "@/src/lib/api/pull-requests.ts";
import {
	BranchTargetPicker,
	DialogDiffStats,
} from "./git-action/branch-target-picker.tsx";

export type GitProgressPhase =
	| "generating"
	| "initializing"
	| "committing"
	| "pushing"
	| "pulling"
	| "syncing"
	| "creating"
	| "creating-repository";

export type PullRequestAction = "draft" | "create" | "open";

export function gitProgressLabel(phase: GitProgressPhase): string {
	switch (phase) {
		case "generating":
			return "Generating message…";
		case "initializing":
			return "Creating local Git…";
		case "committing":
			return "Committing…";
		case "pushing":
			return "Pushing…";
		case "pulling":
			return "Pulling…";
		case "syncing":
			return "Syncing…";
		case "creating":
			return "Creating pull request…";
		case "creating-repository":
			return "Creating GitHub repository…";
	}
}

export interface GitProgressStatusProps {
	onStop?: () => void;
	phase: GitProgressPhase;
}

export function GitProgressStatus({ onStop, phase }: GitProgressStatusProps) {
	return (
		<div
			aria-live="polite"
			className="flex min-h-8 w-full items-center gap-2 rounded-lg bg-muted px-2 text-xs"
			role="status"
		>
			<span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
				<HugeiconsIcon
					aria-hidden
					className="size-3.5 shrink-0 animate-spin"
					icon={Loading01Icon}
				/>
				{gitProgressLabel(phase)}
			</span>
			{onStop && (
				<Button
					aria-label="Stop git action"
					onClick={onStop}
					size="icon-sm"
					title="Stop git action"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon aria-hidden className="size-4" icon={StopIcon} />
				</Button>
			)}
		</div>
	);
}

export function GitRemoteActions({
	onPull,
	onSync,
}: {
	onPull: () => void;
	onSync: () => void;
}) {
	return (
		<div className="grid grid-cols-2 gap-1.5">
			<Button
				aria-label="Pull latest changes"
				onClick={onPull}
				size="sm"
				title="Pull latest changes"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					aria-hidden
					className="size-4 shrink-0"
					icon={ArrowDown01Icon}
				/>
				<span>Pull</span>
			</Button>
			<Button
				aria-label="Sync with remote"
				onClick={onSync}
				size="sm"
				title="Sync with remote"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					aria-hidden
					className="size-4 shrink-0"
					icon={RefreshIcon}
				/>
				<span>Sync</span>
			</Button>
		</div>
	);
}

export interface CreateGitHubRepositoryDialogProps {
	error?: string | null;
	name: string;
	onNameChange: (name: string) => void;
	onOpenChange: (open: boolean) => void;
	onSubmit: (visibility: GitHubRepositoryVisibility) => void;
	onVisibilityChange: (visibility: GitHubRepositoryVisibility) => void;
	open: boolean;
	progress?: GitProgressPhase;
	visibility: GitHubRepositoryVisibility;
}

/** Ask for the provider-facing repository identity only after local Git exists. */
export function CreateGitHubRepositoryDialog({
	error,
	name,
	onNameChange,
	onOpenChange,
	onSubmit,
	onVisibilityChange,
	open,
	progress,
	visibility,
}: CreateGitHubRepositoryDialogProps) {
	const busy = progress !== undefined;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
				data-testid="create-github-repository-dialog"
			>
				<DialogHeader>
					<DialogTitle>Create GitHub repository</DialogTitle>
					<DialogDescription>
						Keep this folder local, or publish it to GitHub after the initial
						commit.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-2">
					<label
						className="font-medium text-sm"
						htmlFor="github-repository-name"
					>
						Repository name
					</label>
					<Input
						aria-label="GitHub repository name"
						disabled={busy}
						id="github-repository-name"
						onChange={(event) => onNameChange(event.target.value)}
						placeholder="my-project"
						value={name}
					/>
				</div>
				<fieldset className="grid gap-2">
					<legend className="font-medium text-sm">Visibility</legend>
					<RadioGroup
						aria-label="Repository visibility"
						onValueChange={(value) => {
							if (value === "private" || value === "public") {
								onVisibilityChange(value);
							}
						}}
						value={visibility}
					>
						<label
							className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-3 transition-colors duration-150 hover:bg-muted hover:duration-0"
							htmlFor="github-repository-private"
						>
							<RadioGroupItem
								aria-label="Private repository"
								disabled={busy}
								id="github-repository-private"
								value="private"
							/>
							<HugeiconsIcon
								aria-hidden
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								icon={SquareLock01Icon}
							/>
							<span className="min-w-0">
								<span className="block font-medium text-sm">Private</span>
								<span className="block text-muted-foreground text-xs">
									Only you and collaborators can see it.
								</span>
							</span>
						</label>
						<label
							className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-3 transition-colors duration-150 hover:bg-muted hover:duration-0"
							htmlFor="github-repository-public"
						>
							<RadioGroupItem
								aria-label="Public repository"
								disabled={busy}
								id="github-repository-public"
								value="public"
							/>
							<HugeiconsIcon
								aria-hidden
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								icon={Globe02Icon}
							/>
							<span className="min-w-0">
								<span className="block font-medium text-sm">Public</span>
								<span className="block text-muted-foreground text-xs">
									Anyone can discover and clone it.
								</span>
							</span>
						</label>
					</RadioGroup>
				</fieldset>
				<p className="text-muted-foreground text-xs leading-5">
					Ryu commits the local folder, creates the GitHub remote, and pushes
					the current branch. GitHub CLI handles your existing sign-in.
				</p>
				{error && (
					<p
						className="mt-3 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-status-destructive"
						role="alert"
					>
						{error}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button
						disabled={busy}
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={busy || !name.trim()}
						onClick={() => onSubmit(visibility)}
						type="button"
					>
						{busy && progress ? gitProgressLabel(progress) : "Create and push"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

const COMMIT_ACTIONS: ReadonlyArray<{
	action: GitCommitAction;
	icon: typeof GitCommitIcon;
	label: string;
}> = [
	{ action: "commit", icon: GitCommitIcon, label: "Commit" },
	{ action: "commit-push", icon: CloudUploadIcon, label: "Commit and push" },
	{ action: "push", icon: CloudUploadIcon, label: "Push" },
];

export interface GitActionDialogProps {
	branch: string;
	branches: string[];
	branchesLoading: boolean;
	commitMessage: string;
	deletions: number;
	error?: string | null;
	includeUnstaged: boolean;
	insertions: number;
	onBranchMenuOpenChange: (open: boolean) => void;
	onCommitMessageChange: (message: string) => void;
	onCreateBranch?: (name: string) => Promise<string | null>;
	onIncludeUnstagedChange: (include: boolean) => void;
	onOpenChange: (open: boolean) => void;
	onSelectBranch: (branch: string) => void;
	onSubmit: (action: GitCommitAction) => void;
	open: boolean;
	progress?: GitProgressPhase;
}

export function GitActionDialog({
	branch,
	branches,
	branchesLoading,
	commitMessage,
	deletions,
	error,
	includeUnstaged,
	insertions,
	onBranchMenuOpenChange,
	onCommitMessageChange,
	onCreateBranch,
	onIncludeUnstagedChange,
	onOpenChange,
	onSelectBranch,
	onSubmit,
	open,
	progress,
}: GitActionDialogProps) {
	const busy = progress !== undefined;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Commit or push changes</DialogTitle>
					<DialogDescription>
						Choose a branch and an action for the current changes.
					</DialogDescription>
				</DialogHeader>
				<BranchTargetPicker
					branch={branch}
					branches={branches}
					disabled={busy}
					loading={branchesLoading}
					onBranchMenuOpenChange={onBranchMenuOpenChange}
					onCreateBranch={onCreateBranch}
					onSelectBranch={onSelectBranch}
				/>
				<Textarea
					aria-label="Commit message"
					className="max-h-60 min-h-28"
					disabled={busy}
					onChange={(event) => onCommitMessageChange(event.target.value)}
					placeholder="Commit message (leave blank to generate)…"
					value={commitMessage}
				/>
				<label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto]">
					<Checkbox
						checked={includeUnstaged}
						disabled={busy}
						onCheckedChange={(checked) =>
							onIncludeUnstagedChange(checked === true)
						}
					/>
					<span className="min-w-0 flex-1">Include unstaged changes</span>
					<DialogDiffStats deletions={deletions} insertions={insertions} />
				</label>
				{error && (
					<p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
						{error}
					</p>
				)}
				<div className="grid gap-2 border-border border-t pt-4">
					{COMMIT_ACTIONS.map((item, index) => (
						<Button
							className="w-full justify-start"
							disabled={busy}
							key={item.action}
							onClick={() => onSubmit(item.action)}
							type="button"
							variant={index === 0 ? "secondary" : "ghost"}
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

export {
	PullRequestDialog,
	type PullRequestDialogProps,
} from "./git-action/pull-request-dialog.tsx";

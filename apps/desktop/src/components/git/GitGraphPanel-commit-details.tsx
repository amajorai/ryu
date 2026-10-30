import { GitCommitIcon, SourceCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import type { GitGraphBranch, GitGraphCommit } from "@/src/lib/git-graph.ts";

export function CommitDetails({
	commit,
	currentBranch,
	changedFiles,
	folder,
	onOpenChanges,
}: {
	commit: GitGraphCommit | null;
	currentBranch?: GitGraphBranch;
	changedFiles: number;
	folder: string;
	onOpenChanges: () => void;
}) {
	const tl = useLiteralMessages();
	if (!commit) {
		return <GraphEmptyState text="Select a commit to inspect its details." />;
	}
	return (
		<div className="flex h-full flex-col">
			<div className="border-border/60 border-b px-4 py-3">
				<div className="flex items-center gap-2 text-muted-foreground text-xs">
					<HugeiconsIcon
						className="size-3.5 text-primary"
						icon={GitCommitIcon}
					/>
					<span>Commit details</span>
				</div>
				<h2 className="mt-2 font-medium text-sm leading-snug">
					{commit.subject}
				</h2>
			</div>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs">
				<DetailRow label="Commit">
					<code className="font-mono text-foreground/80">{commit.sha}</code>
				</DetailRow>
				<DetailRow label="Author">{commit.author}</DetailRow>
				<DetailRow label="Updated">{commit.date}</DetailRow>
				{commit.refs.length > 0 && (
					<div>
						<div className="mb-1 text-muted-foreground">Refs</div>
						<div className="flex flex-wrap gap-1">
							{commit.refs.map((ref) => (
								<span
									className="type-compact rounded-full bg-primary/10 px-2 py-1 text-primary"
									key={ref}
								>
									{ref}
								</span>
							))}
						</div>
					</div>
				)}
				{commit.parents.length > 0 && (
					<div>
						<div className="mb-1 text-muted-foreground">Parents</div>
						<div className="space-y-1">
							{commit.parents.map((parent) => (
								<code
									className="block truncate font-mono text-foreground/70"
									key={parent}
									title={parent}
								>
									{parent}
								</code>
							))}
						</div>
					</div>
				)}
				<div className="rounded-lg border border-border/60 bg-muted/25 p-3 text-muted-foreground leading-relaxed">
					{currentBranch
						? `${tl("HEAD is on {name}.", { name: currentBranch.name })} `
						: "This repository has no checked-out branch. "}
					{changedFiles > 0
						? "The working tree has local changes."
						: "The working tree is clean."}
				</div>
			</div>
			<div className="border-border/60 border-t px-4 py-3">
				<button
					className="flex w-full items-center justify-center gap-2 rounded-md bg-muted px-3 py-2 font-medium text-xs transition-colors hover:bg-muted/80"
					onClick={onOpenChanges}
					type="button"
				>
					<HugeiconsIcon className="size-3.5" icon={SourceCodeIcon} />
					Open project changes
				</button>
				<div
					className="type-compact mt-2 truncate text-center text-muted-foreground/60"
					title={folder}
				>
					{folder}
				</div>
			</div>
		</div>
	);
}

function DetailRow({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-foreground/85">{children}</span>
		</div>
	);
}

export function GraphEmptyState({ text }: { text: string }) {
	return (
		<div className="flex h-full min-h-36 items-center justify-center p-4 text-center text-muted-foreground text-xs">
			{text}
		</div>
	);
}

// apps/desktop/src/components/chat/DiffReviewPane.tsx
//
// Displays the aggregate diff for a completed run (Unit U011/U012). Shows the
// per-file summary list alongside the full unified diff in a collapsible pane,
// plus Apply (merge) and Open PR buttons to land the changes.

import {
	Add01Icon,
	AlertCircleIcon,
	ArrowDown01Icon,
	ArrowRight01Icon,
	CheckmarkCircle02Icon,
	FileCodeIcon,
	GitMergeIcon,
	Loading01Icon,
	MinusSignIcon,
	Share08Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ApplyResult,
	FileSummary,
	WorktreeDiff,
} from "@/src/lib/api/git.ts";
import { applyWorktree, fetchWorktreeDiff } from "@/src/lib/api/git.ts";

interface DiffReviewPaneProps {
	runId: string;
	target: ApiTarget;
}

// ── Line-level diff renderer ──────────────────────────────────────────────────

function DiffLine({ line }: { line: string }) {
	const isAdd = line.startsWith("+") && !line.startsWith("+++");
	const isDel = line.startsWith("-") && !line.startsWith("---");
	const isHunk = line.startsWith("@@");
	const isFilePath = line.startsWith("---") || line.startsWith("+++");

	let cls = "font-mono text-[11px] leading-5 px-2 whitespace-pre select-text";
	if (isAdd) {
		cls += " bg-success dark:bg-success/30 text-success dark:text-success";
	} else if (isDel) {
		cls +=
			" bg-destructive dark:bg-destructive/30 text-destructive dark:text-destructive";
	} else if (isHunk) {
		cls += " bg-info dark:bg-info/20 text-info dark:text-info";
	} else if (isFilePath) {
		cls += " text-muted-foreground";
	} else {
		cls += " text-foreground";
	}

	return <div className={cls}>{line || " "}</div>;
}

// ── Per-file summary row ──────────────────────────────────────────────────────

function FileSummaryRow({ file }: { file: FileSummary }) {
	const filename = file.path.split("/").at(-1) ?? file.path;
	const kindLabel =
		file.kind === "added"
			? "A"
			: file.kind === "deleted"
				? "D"
				: file.kind === "renamed"
					? "R"
					: "M";
	const kindClass =
		file.kind === "added"
			? "text-success dark:text-success"
			: file.kind === "deleted"
				? "text-destructive dark:text-destructive"
				: "text-muted-foreground";

	return (
		<div className="flex items-center gap-2 rounded px-3 py-1 text-xs hover:bg-muted/30">
			<span className={`w-3 shrink-0 font-bold font-mono ${kindClass}`}>
				{kindLabel}
			</span>
			<HugeiconsIcon
				aria-hidden
				className="size-3 shrink-0 text-muted-foreground"
				icon={FileCodeIcon}
			/>
			<Tooltip>
				<TooltipTrigger
					render={
						<span className="truncate font-mono text-foreground">
							{filename}
						</span>
					}
				/>
				<TooltipContent>{file.path}</TooltipContent>
			</Tooltip>
			{(file.additions > 0 || file.deletions > 0) && (
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
					{file.additions > 0 && (
						<span className="flex items-center gap-0.5 text-success dark:text-success">
							<HugeiconsIcon
								aria-hidden
								className="size-2.5"
								icon={Add01Icon}
							/>
							{file.additions}
						</span>
					)}
					{file.deletions > 0 && (
						<span className="flex items-center gap-0.5 text-destructive dark:text-destructive">
							<HugeiconsIcon
								aria-hidden
								className="size-2.5"
								icon={MinusSignIcon}
							/>
							{file.deletions}
						</span>
					)}
				</span>
			)}
		</div>
	);
}

// ── Apply state ───────────────────────────────────────────────────────────────

type ApplyState =
	| { status: "idle" }
	| { status: "loading"; mode: "merge" | "pr" }
	| { status: "merged"; commit: string | null }
	| { status: "pr"; prUrl: string }
	| { status: "conflict"; conflictedFiles: string[] }
	| { status: "error"; message: string };

// ── Main pane ─────────────────────────────────────────────────────────────────

export function DiffReviewPane({ target, runId }: DiffReviewPaneProps) {
	const [diff, setDiff] = useState<WorktreeDiff | null>(null);
	const [expanded, setExpanded] = useState(false);
	const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;

		fetchWorktreeDiff(target, runId, controller.signal).then((d) => {
			if (!controller.signal.aborted) {
				setDiff(d);
			}
		});

		return () => {
			controller.abort();
		};
	}, [target, runId]);

	const handleApply = async (mode: "merge" | "pr") => {
		setApplyState({ status: "loading", mode });
		try {
			const result: ApplyResult = await applyWorktree(target, runId, {
				mode,
				message: `Applied run ${runId}`,
			});
			if (result.success) {
				if (result.pr_url) {
					setApplyState({ status: "pr", prUrl: result.pr_url });
				} else {
					setApplyState({ status: "merged", commit: result.commit });
				}
			} else {
				setApplyState({
					status: "conflict",
					conflictedFiles: result.conflicted_files,
				});
			}
		} catch (err) {
			setApplyState({
				status: "error",
				message: err instanceof Error ? err.message : "apply failed",
			});
		}
	};

	// Render nothing until the diff is fetched or when there are no changes.
	if (!diff?.has_changes) {
		return null;
	}

	const diffLines = diff.unified_diff.split("\n");
	const totalAdditions = diff.files.reduce((sum, f) => sum + f.additions, 0);
	const totalDeletions = diff.files.reduce((sum, f) => sum + f.deletions, 0);

	const applied =
		applyState.status === "merged" ||
		applyState.status === "pr" ||
		applyState.status === "conflict";

	return (
		<div className="overflow-hidden rounded-md bg-background text-sm">
			<button
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30"
				onClick={() => setExpanded((prev) => !prev)}
				type="button"
			>
				{expanded ? (
					<HugeiconsIcon
						aria-hidden
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
					/>
				) : (
					<HugeiconsIcon
						aria-hidden
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={ArrowRight01Icon}
					/>
				)}
				<HugeiconsIcon
					aria-hidden
					className="size-3.5 shrink-0 text-muted-foreground"
					icon={WorkflowCircle06Icon}
				/>
				<span className="font-medium text-xs">
					{diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed
				</span>
				<span className="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
					{totalAdditions > 0 && (
						<span className="text-success dark:text-success">
							+{totalAdditions}
						</span>
					)}
					{totalDeletions > 0 && (
						<span className="text-destructive dark:text-destructive">
							-{totalDeletions}
						</span>
					)}
				</span>
			</button>

			{expanded && (
				<div className="border-border border-t">
					<div className="border-border/50 border-b py-1">
						{diff.files.map((file) => (
							<FileSummaryRow file={file} key={file.path} />
						))}
					</div>
					<div className="max-h-96 overflow-auto">
						{diffLines.map((line, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: stable sequential diff lines
							<DiffLine key={idx} line={line} />
						))}
					</div>
				</div>
			)}

			{/* Apply / Open PR actions */}
			<div className="flex flex-col gap-1.5 border-border border-t px-3 py-2">
				{applyState.status === "idle" && (
					<div className="flex items-center gap-2">
						<button
							className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs transition-colors hover:bg-primary/90"
							onClick={() => handleApply("merge")}
							type="button"
						>
							<HugeiconsIcon
								aria-hidden
								className="size-3"
								icon={GitMergeIcon}
							/>
							Apply (merge)
						</button>
						<button
							className="flex items-center gap-1.5 rounded px-2.5 py-1 font-medium text-xs transition-colors hover:bg-muted/30"
							onClick={() => handleApply("pr")}
							type="button"
						>
							<HugeiconsIcon
								aria-hidden
								className="size-3"
								icon={Share08Icon}
							/>
							Open PR
						</button>
					</div>
				)}

				{applyState.status === "loading" && (
					<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<HugeiconsIcon
							aria-hidden
							className="size-3 animate-spin"
							icon={Loading01Icon}
						/>
						{applyState.mode === "merge" ? "Merging…" : "Opening PR…"}
					</div>
				)}

				{applyState.status === "merged" && (
					<div className="flex items-center gap-1.5 text-success text-xs dark:text-success">
						<HugeiconsIcon
							aria-hidden
							className="size-3"
							icon={CheckmarkCircle02Icon}
						/>
						Merged
						{applyState.commit && (
							<span className="font-mono text-muted-foreground">
								{applyState.commit.slice(0, 8)}
							</span>
						)}
					</div>
				)}

				{applyState.status === "pr" && (
					<div className="flex items-center gap-1.5 text-xs">
						<HugeiconsIcon
							aria-hidden
							className="size-3 text-success dark:text-success"
							icon={CheckmarkCircle02Icon}
						/>
						<a
							className="truncate text-info underline underline-offset-2 dark:text-info"
							href={applyState.prUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							{applyState.prUrl}
						</a>
					</div>
				)}

				{applyState.status === "conflict" && (
					<div className="flex flex-col gap-1 text-xs">
						<div className="flex items-center gap-1.5 text-warning dark:text-warning">
							<HugeiconsIcon
								aria-hidden
								className="size-3"
								icon={AlertCircleIcon}
							/>
							Merge conflict — worktree cleaned up safely
						</div>
						{applyState.conflictedFiles.length > 0 && (
							<ul className="ml-4 list-disc font-mono text-muted-foreground">
								{applyState.conflictedFiles.map((f: string) => (
									<li key={f}>{f}</li>
								))}
							</ul>
						)}
					</div>
				)}

				{applyState.status === "error" && (
					<div className="flex items-center gap-1.5 text-destructive text-xs dark:text-destructive">
						<HugeiconsIcon
							aria-hidden
							className="size-3"
							icon={AlertCircleIcon}
						/>
						{applyState.message}
						{!applied && (
							<button
								className="ml-1 underline underline-offset-2"
								onClick={() => setApplyState({ status: "idle" })}
								type="button"
							>
								Retry
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

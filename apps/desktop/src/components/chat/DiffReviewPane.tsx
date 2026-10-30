// apps/desktop/src/components/chat/DiffReviewPane.tsx
//
// Displays the aggregate diff for a completed run (Unit U011/U012). Shows the
// per-file summary list alongside the full unified diff in a collapsible pane,
// plus Apply (merge) and Open PR buttons to land the changes.

import {
	ArrowDown01Icon,
	FileCodeIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FileContents } from "@pierre/diffs";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type ApplyState,
	DiffReviewApplyActions,
} from "@/src/components/chat/DiffReviewPane-apply-actions.tsx";
import { FileSummaryRow } from "@/src/components/chat/DiffReviewPane-file-summary-row.tsx";
import {
	patchForFile,
	RichPatchDiff,
} from "@/src/components/diffs/RichPatchDiff.tsx";
import {
	diffViewPrefsToOptions,
	useDiffViewPrefs,
} from "@/src/hooks/useDiffViewPrefs.ts";
import {
	invalidateGitStatus,
	invalidateWorktreeDiff,
	invalidateWorktreeStatus,
	useWorktreeDiff,
	useWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ApplyResult } from "@/src/lib/api/git.ts";
import { applyWorktree } from "@/src/lib/api/git.ts";
import {
	joinPath,
	readGitProjectFile,
	readProjectFile,
	writeProjectFile,
} from "@/src/lib/files.ts";

interface DiffReviewPaneProps {
	runId: string;
	target: ApiTarget;
	/**
	 * Optional run-trace waterfall. It renders inside the pane's disclosure, so
	 * collapsing the review hides the trace with it instead of stacking a second
	 * framed box under the pane.
	 */
	trace?: ReactNode;
}

interface FullDiffFiles {
	newFile: FileContents | null;
	oldFile: FileContents | null;
}

// ── Main pane ─────────────────────────────────────────────────────────────────

export function DiffReviewPane({ target, runId, trace }: DiffReviewPaneProps) {
	// The shared query, not a one-shot fetch on mount: this pane used to show
	// whatever the diff was the first time it rendered, for as long as it stayed
	// mounted — including after the change had been committed outside the app.
	const diff = useWorktreeDiff(target, runId);
	const worktreeStatus = useWorktreeStatus(target, runId);
	const diffPrefs = useDiffViewPrefs();
	const tl = useLiteralMessages();
	const diffOptions = useMemo(
		() => diffViewPrefsToOptions(diffPrefs),
		[diffPrefs]
	);
	const [expanded, setExpanded] = useState(true);
	const [editMode, setEditMode] = useState(false);
	const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });
	const [filter, setFilter] = useState("");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	const handleApply = async (mode: "merge" | "pr") => {
		setApplyState({ status: "loading", mode });
		try {
			const result: ApplyResult = await applyWorktree(target, runId, {
				mode,
				message: `Applied run ${runId}`,
			});
			if (result.success) {
				// Applying a worktree changes both the worktree and the repo it
				// merges into, so refresh every git surface rather than this pane.
				invalidateGitStatus();
				invalidateWorktreeStatus(runId);
				invalidateWorktreeDiff(runId);
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

	useEffect(() => {
		if (
			diff.files.length > 0 &&
			!(selectedPath && diff.files.some((file) => file.path === selectedPath))
		) {
			setSelectedPath(diff.files[0]?.path ?? null);
		}
	}, [diff.files, selectedPath]);

	const visibleFiles = useMemo(() => {
		const query = filter.trim().toLowerCase();
		return query
			? diff.files.filter((file) => file.path.toLowerCase().includes(query))
			: diff.files;
	}, [diff.files, filter]);
	const selectedFile =
		diff.files.find((file) => file.path === selectedPath) ?? diff.files[0];
	const selectedPatch = selectedFile
		? patchForFile(diff.unified_diff, selectedFile.path)
		: diff.unified_diff;
	const [fullFiles, setFullFiles] = useState<FullDiffFiles | null>(null);
	useEffect(() => {
		const folder = worktreeStatus.path;
		const path = selectedFile?.path;
		if (!(folder && path)) {
			setFullFiles(null);
			return;
		}

		let cancelled = false;
		setFullFiles(null);
		Promise.all([
			readGitProjectFile(folder, path).catch(() => null),
			readProjectFile(joinPath(folder, path)).catch(() => null),
		]).then(([oldContents, newContents]) => {
			if (cancelled) {
				return;
			}
			setFullFiles({
				oldFile:
					oldContents === null
						? null
						: {
								cacheKey: `${path}:HEAD`,
								contents: oldContents,
								name: path,
							},
				newFile:
					newContents === null
						? null
						: {
								cacheKey: `${path}:working`,
								contents: newContents,
								name: path,
							},
			});
		});

		return () => {
			cancelled = true;
		};
	}, [selectedFile?.path, worktreeStatus.path, diff.unified_diff]);
	const totalAdditions = diff.files.reduce((sum, f) => sum + f.additions, 0);
	const totalDeletions = diff.files.reduce((sum, f) => sum + f.deletions, 0);
	const saveEditedFile = useCallback(
		async (file: { contents: string }) => {
			if (!(worktreeStatus.path && selectedFile)) {
				return;
			}
			await writeProjectFile(
				joinPath(worktreeStatus.path, selectedFile.path),
				file.contents
			);
			invalidateGitStatus();
			invalidateWorktreeDiff(runId);
		},
		[runId, selectedFile, worktreeStatus.path]
	);

	const applied =
		applyState.status === "merged" ||
		applyState.status === "pr" ||
		applyState.status === "conflict";

	// Render nothing until the diff is fetched or when there are no changes. Keep
	// this after hooks so a live query changing state never changes hook order.
	if (!diff.has_changes) {
		return null;
	}

	return (
		<div className="@container overflow-hidden rounded-xl border border-border bg-background text-sm">
			<div className="flex h-10 items-center gap-1 pr-2">
				<button
					aria-expanded={expanded}
					className="flex h-10 min-w-0 flex-1 items-center gap-2 px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={() => setExpanded((prev) => !prev)}
					type="button"
				>
					<HugeiconsIcon
						aria-hidden
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) ease-move",
							expanded ? "rotate-0" : "-rotate-90"
						)}
						icon={ArrowDown01Icon}
					/>
					<span className="font-medium text-sm">
						{tl(
							"{fileCount, plural, one {{fileCountLabel} file changed} other {{fileCountLabel} files changed}}",
							{
								fileCount: diff.files.length,
								fileCountLabel: formatCount(diff.files.length) ?? "—",
							}
						)}
					</span>
					<span className="ml-auto flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
						{totalAdditions > 0 && (
							<span className="text-status-success">
								+{formatCount(totalAdditions)}
							</span>
						)}
						{totalDeletions > 0 && (
							<span className="text-status-destructive">
								-{formatCount(totalDeletions)}
							</span>
						)}
					</span>
				</button>
				<Button
					aria-pressed={editMode}
					className="aria-pressed:bg-muted aria-pressed:text-foreground"
					onClick={() => setEditMode((current) => !current)}
					size="sm"
					variant="ghost-muted"
				>
					{editMode ? "Editing" : "Edit"}
				</Button>
			</div>

			{expanded && (
				<div className="border-border border-t">
					<div className="grid min-h-72 @4xl:grid-cols-[minmax(0,1fr)_15rem]">
						<div className="min-w-0 overflow-hidden border-border @4xl:border-r">
							<div className="flex h-10 items-center gap-2 border-border border-b px-3 text-xs">
								<HugeiconsIcon
									aria-hidden
									className="size-3.5 text-muted-foreground"
									icon={FileCodeIcon}
								/>
								<span
									className="min-w-0 flex-1 truncate font-mono"
									title={selectedFile?.path ?? "Changes"}
								>
									{selectedFile?.path ?? "Changes"}
								</span>
								{selectedFile && (
									<span className="flex shrink-0 gap-1.5 tabular-nums">
										<span className="text-status-success">
											+{formatCount(selectedFile.additions)}
										</span>
										<span className="text-status-destructive">
											-{formatCount(selectedFile.deletions)}
										</span>
									</span>
								)}
							</div>
							<div className="max-h-[34rem] overflow-auto p-2">
								<RichPatchDiff
									editMode={editMode}
									filePath={selectedFile?.path}
									newFile={fullFiles?.newFile}
									oldFile={fullFiles?.oldFile}
									onSave={worktreeStatus.path ? saveEditedFile : undefined}
									options={diffOptions}
									patch={selectedPatch}
								/>
							</div>
						</div>
						<aside className="border-border border-t @4xl:border-t-0 p-2">
							<div className="relative mb-2">
								<HugeiconsIcon
									aria-hidden
									className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
									icon={Search01Icon}
								/>
								<Input
									aria-label="Filter changed files"
									className="pl-8 text-xs"
									onChange={(event) => setFilter(event.target.value)}
									placeholder="Filter files…"
									size="settings-search"
									value={filter}
								/>
							</div>
							<div className="flex h-8 items-center gap-2 px-2 text-muted-foreground text-xs">
								<span>Changed files</span>
								<span className="ml-auto text-muted-foreground/70 tabular-nums">
									{formatCount(visibleFiles.length) ?? "—"}
								</span>
							</div>
							<div className="scroll-fade max-h-64 overflow-y-auto">
								{visibleFiles.map((file) => (
									<FileSummaryRow
										file={file}
										key={file.path}
										onSelect={() => setSelectedPath(file.path)}
										patch={patchForFile(diff.unified_diff, file.path)}
										selected={file.path === selectedFile?.path}
									/>
								))}
								{visibleFiles.length === 0 && (
									<p className="px-2 py-4 text-center text-muted-foreground text-xs">
										No matching files
									</p>
								)}
							</div>
						</aside>
					</div>
					{trace ? (
						<div className="border-border border-t p-2">{trace}</div>
					) : null}
				</div>
			)}

			<DiffReviewApplyActions
				applied={applied}
				applyState={applyState}
				handleApply={handleApply}
				setApplyState={setApplyState}
			/>
		</div>
	);
}

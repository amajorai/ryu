import {
	ArrowDown01Icon,
	FileCodeIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	RichPatchDiff,
	splitPatchByFile,
} from "@/src/components/diffs/RichPatchDiff.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	diffViewPrefsToOptions,
	setDiffViewPrefs,
	useDiffViewPrefs,
} from "@/src/hooks/useDiffViewPrefs.ts";
import { invalidateGitStatus } from "@/src/hooks/useGitStatus.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchGitFileDiff } from "@/src/lib/api/git.ts";
import {
	joinPath,
	readGitProjectFile,
	readProjectFile,
	writeProjectFile,
} from "@/src/lib/files.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	buildDiffCommand,
	type CommitInfo,
	type DiffMode,
	EAGER_DIFF_FILE_COUNT,
	type FileReviewRequest,
	type FullDiffFiles,
	GIT_LOG_FORMAT,
	LARGE_PATCH_FILE_COUNT,
	shortSha,
} from "./patch-diff-model.ts";

export type { FileReviewRequest } from "./patch-diff-model.ts";

export function PatchDiffPanel({
	fileReviewRequest,
	folder,
}: {
	fileReviewRequest?: FileReviewRequest | null;
	folder?: string | null;
}) {
	const [mode, setMode] = useState<DiffMode>("working");
	const [commit, setCommit] = useState<CommitInfo | null>(null);
	const [branch, setBranch] = useState<string | null>(null);
	const [commits, setCommits] = useState<CommitInfo[]>([]);
	const [branches, setBranches] = useState<string[]>([]);
	const [patch, setPatch] = useState("");
	const [diffError, setDiffError] = useState<string | null>(null);
	const [dismissedReviewNonce, setDismissedReviewNonce] = useState<
		number | null
	>(null);
	const [fullFiles, setFullFiles] = useState<Record<string, FullDiffFiles>>({});
	const [loading, setLoading] = useState(false);
	const [editMode, setEditMode] = useState(false);
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const activeNode = useActiveNode();
	const target = useMemo(
		() => toTarget(activeNode),
		[activeNode.token, activeNode.url]
	);
	const reviewActive = Boolean(
		fileReviewRequest && dismissedReviewNonce !== fileReviewRequest.nonce
	);
	const diffPrefs = useDiffViewPrefs();

	// Translate the plain-English prefs into `@pierre/diffs` options once per change.
	const diffOptions = useMemo(
		() => diffViewPrefsToOptions(diffPrefs),
		[diffPrefs]
	);

	const git = useCallback(
		async (command: string): Promise<string> => {
			if (!folder) {
				return "";
			}
			const shellArg = terminalShell === "auto" ? null : terminalShell;
			const result = await invoke<{
				stdout: string;
				stderr: string;
				code: number;
			}>("shell_execute", { command, cwd: folder, shell: shellArg });
			if (result.code !== 0) {
				throw new Error(
					result.stderr.trim() ||
						`The Git command exited with status ${result.code}.`
				);
			}
			return result.stdout;
		},
		[folder, terminalShell]
	);

	// Populate the Commit / Branch sub-menus. Best-effort: a folder that is not a
	// Git repo (or has no commits yet) fails here and the sub-menus stay empty.
	useEffect(() => {
		if (!folder) {
			setCommits([]);
			setBranches([]);
			return;
		}
		setCommits([]);
		setBranches([]);
		git(`git log -n 50 --pretty=format:${GIT_LOG_FORMAT}`)
			.then((out) => {
				const list: CommitInfo[] = [];
				for (const line of out.split("\n")) {
					const tab = line.indexOf("\t");
					if (tab > 0) {
						list.push({
							sha: line.slice(0, tab),
							subject: line.slice(tab + 1),
						});
					}
				}
				setCommits(list);
			})
			.catch(() => undefined);
		git('git branch --format="%(refname:short)"')
			.then((out) => {
				setBranches(
					out
						.split("\n")
						.map((b) => b.trim())
						.filter(Boolean)
				);
			})
			.catch(() => undefined);
	}, [folder, git]);

	const refresh = useCallback(() => {
		if (!folder) {
			setPatch("");
			return;
		}
		setLoading(true);
		setDiffError(null);
		const request =
			reviewActive && fileReviewRequest
				? fetchGitFileDiff(target, folder, fileReviewRequest.paths).then(
						(result) => result.patch
					)
				: git(buildDiffCommand(mode, commit, branch));
		request
			.then((out) => setPatch(out))
			.catch((error) => {
				setPatch("");
				setDiffError(
					error instanceof Error
						? error.message
						: "The file diff could not be read."
				);
			})
			.finally(() => setLoading(false));
	}, [
		branch,
		commit,
		fileReviewRequest,
		folder,
		git,
		mode,
		reviewActive,
		target,
	]);

	const saveEditedFile = useCallback(
		async (path: string, file: { contents: string }) => {
			if (!folder || mode !== "working") {
				return;
			}
			await writeProjectFile(joinPath(folder, path), file.contents);
			invalidateGitStatus(folder);
			toast.success(`${path} saved`);
		},
		[folder, mode]
	);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// PatchDiff is intentionally read-only for partial patches. Hydrate the
	// working-tree view with both file versions so the library can attach its
	// full editor surface when Edit mode is enabled.
	useEffect(() => {
		if (!folder || mode !== "working" || !editMode || !patch.trim()) {
			setFullFiles({});
			return;
		}

		let cancelled = false;
		setFullFiles({});
		const files = splitPatchByFile(patch);

		void Promise.all(
			files.map(async (file): Promise<[string, FullDiffFiles]> => {
				const [oldContents, newContents] = await Promise.all([
					readGitProjectFile(folder, file.path).catch(() => ""),
					readProjectFile(joinPath(folder, file.path)).catch(() => null),
				]);
				return [
					file.path,
					{
						oldFile: {
							cacheKey: `${file.path}:HEAD`,
							contents: oldContents,
							name: file.path,
						},
						newFile:
							newContents === null
								? null
								: {
										cacheKey: `${file.path}:working`,
										contents: newContents,
										name: file.path,
									},
					},
				];
			})
		).then((entries) => {
			if (!cancelled) {
				setFullFiles(Object.fromEntries(entries));
			}
		});

		return () => {
			cancelled = true;
		};
	}, [editMode, folder, git, mode, patch]);

	const modeLabel = (() => {
		if (reviewActive) {
			return "Files from this turn";
		}
		if (mode === "staged") {
			return "Staged";
		}
		if (mode === "commit") {
			return commit ? `${shortSha(commit.sha)} ${commit.subject}` : "Commit";
		}
		if (mode === "branch") {
			return branch ? `${branch}…HEAD` : "Branch";
		}
		return "Working tree";
	})();

	if (!folder) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
				No project folder open.
			</div>
		);
	}

	let body: ReactNode;
	if (loading) {
		body = (
			<div className="flex h-full animate-skeleton items-center justify-center text-muted-foreground text-xs">
				Loading diff…
			</div>
		);
	} else if (diffError) {
		body = (
			<div
				className="flex h-full items-center justify-center p-4 text-center text-status-destructive text-xs"
				role="alert"
			>
				{diffError}
			</div>
		);
	} else if (patch.trim()) {
		const files = splitPatchByFile(patch);
		const collapseTail = files.length > LARGE_PATCH_FILE_COUNT;
		body = (
			<div className="flex flex-col gap-3">
				{files.map((file, i) => (
					<RichPatchDiff
						editMode={editMode}
						filePath={file.path}
						key={file.path}
						newFile={fullFiles[file.path]?.newFile}
						oldFile={fullFiles[file.path]?.oldFile}
						onSave={
							mode === "working"
								? (edited) => saveEditedFile(file.path, edited)
								: undefined
						}
						options={{
							...diffOptions,
							collapsed: collapseTail && i >= EAGER_DIFF_FILE_COUNT,
						}}
						patch={file.patch}
					/>
				))}
			</div>
		);
	} else {
		body = (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				No changes for this selection.
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{/* Diff source selector */}
			<div
				className="flex shrink-0 items-center gap-1 border-0 border-none bg-transparent px-1.5 py-1 shadow-none"
				data-diff-toolbar="true"
			>
				<DropdownMenu>
					<DropdownMenuTrigger
						className="flex min-w-0 max-w-full items-center"
						variant="breadcrumbs"
					>
						<HugeiconsIcon className="size-3.5 shrink-0" icon={FileCodeIcon} />
						<span className="truncate" title={modeLabel}>
							{modeLabel}
						</span>
						<HugeiconsIcon
							className="size-3.5 shrink-0 opacity-60"
							icon={ArrowDown01Icon}
						/>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" side="bottom">
						<DropdownMenuItem
							density="compact"
							onClick={() => {
								setMode("working");
								setDismissedReviewNonce(fileReviewRequest?.nonce ?? null);
							}}
						>
							Working tree
						</DropdownMenuItem>
						<DropdownMenuItem
							density="compact"
							onClick={() => {
								setEditMode(false);
								setMode("staged");
							}}
						>
							Staged
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger density="compact">
								Commit
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[60vh] max-w-[360px] overflow-auto">
								{commits.length === 0 ? (
									<DropdownMenuItem density="compact" disabled tone="muted">
										No commits
									</DropdownMenuItem>
								) : (
									commits.map((c) => (
										<DropdownMenuItem
											density="compact"
											key={c.sha}
											onClick={() => {
												setEditMode(false);
												setCommit(c);
												setMode("commit");
											}}
											spacing="comfortable"
										>
											<span className="shrink-0 font-mono text-xs opacity-60">
												{shortSha(c.sha)}
											</span>
											<span className="truncate" title={c.subject}>
												{c.subject}
											</span>
										</DropdownMenuItem>
									))
								)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger density="compact">
								Branch
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[60vh] max-w-[360px] overflow-auto">
								{branches.length === 0 ? (
									<DropdownMenuItem density="compact" disabled tone="muted">
										No branches
									</DropdownMenuItem>
								) : (
									branches.map((b) => (
										<DropdownMenuItem
											density="compact"
											key={b}
											onClick={() => {
												setEditMode(false);
												setBranch(b);
												setMode("branch");
											}}
										>
											{b}
										</DropdownMenuItem>
									))
								)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					</DropdownMenuContent>
				</DropdownMenu>
				<div className="flex-1" />
				{/* Quick split ↔ stacked toggle. Full option set lives in
				    Settings › Appearance › Diff viewer. */}
				<div className="mr-1 flex shrink-0 items-center gap-0.5">
					{(
						[
							["split", "Split"],
							["unified", "Stacked"],
						] as const
					).map(([value, label]) => (
						<button
							aria-pressed={diffPrefs.diffStyle === value}
							className={cn(
								"h-6 rounded-full px-2 font-medium text-xs transition-colors",
								diffPrefs.diffStyle === value
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
							)}
							key={value}
							onClick={() => setDiffViewPrefs({ diffStyle: value })}
							type="button"
						>
							{label}
						</button>
					))}
				</div>
				<button
					aria-pressed={editMode}
					className={cn(
						"h-6 rounded-full px-2.5 font-medium text-xs transition-colors",
						mode !== "working" && "cursor-not-allowed opacity-50",
						editMode
							? "bg-primary text-primary-foreground"
							: "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
					)}
					disabled={mode !== "working"}
					onClick={() => setEditMode((current) => !current)}
					type="button"
				>
					{editMode ? "Editing" : "Edit"}
				</button>
				<Tooltip>
					<TooltipTrigger
						render={
							<button
								aria-label="Refresh diff"
								className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
								onClick={refresh}
								type="button"
							>
								<HugeiconsIcon
									className={cn("size-3.5", loading && "animate-spin")}
									icon={RefreshIcon}
								/>
							</button>
						}
					/>
					<TooltipContent>Refresh diff</TooltipContent>
				</Tooltip>
			</div>

			{/* Diff body (@pierre/diffs renders at content height and scrolls here) */}
			<div className="min-h-0 flex-1 overflow-auto">{body}</div>
		</div>
	);
}

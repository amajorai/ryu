import {
	ArrowDown01Icon,
	GitBranchIcon,
	RefreshIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import {
	buildGitGraphLogCommand,
	buildGitGraphRows,
	type GitGraphBranch,
	type GitGraphCommit,
	type GitGraphRow,
	parseGitGraphBranches,
	parseGitGraphLog,
} from "@/src/lib/git-graph.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	CommitDetails,
	GraphEmptyState,
} from "./GitGraphPanel-commit-details.tsx";
import {
	BranchRefRow,
	GitGraphCommitRow,
} from "./GitGraphPanel-commit-row.tsx";

interface GitCommandResult {
	code: number;
	stderr: string;
	stdout: string;
}

interface GitGraphPanelProps {
	compact?: boolean;
	folder?: string | null;
}

export function GitGraphPanel({ compact = false, folder }: GitGraphPanelProps) {
	const tl = useLiteralMessages();
	const terminalShell = useWorkspaceStore((state) => state.terminalShell);
	const openTab = useTabSelector((state) => state.openTab);
	const [commits, setCommits] = useState<GitGraphCommit[]>([]);
	const [branches, setBranches] = useState<GitGraphBranch[]>([]);
	const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
	const [selectedSha, setSelectedSha] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [changedFiles, setChangedFiles] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const git = useCallback(
		async (command: string): Promise<GitCommandResult> => {
			if (!folder) {
				return { code: 1, stderr: "No folder", stdout: "" };
			}
			try {
				return await invoke<GitCommandResult>("shell_execute", {
					command,
					cwd: folder,
					shell: terminalShell === "auto" ? null : terminalShell,
				});
			} catch (cause) {
				return {
					code: 1,
					stderr: cause instanceof Error ? cause.message : String(cause),
					stdout: "",
				};
			}
		},
		[folder, terminalShell]
	);

	const refresh = useCallback(async () => {
		if (!folder) {
			setCommits([]);
			setBranches([]);
			setError(null);
			return;
		}

		setLoading(true);
		setError(null);
		const [logResult, branchResult, statusResult] = await Promise.all([
			git(buildGitGraphLogCommand(selectedBranch ?? undefined)),
			git(
				"git branch --all --no-color --format='%(HEAD)%09%(refname:short)%09%(objectname)'"
			),
			git("git status --short --branch --untracked-files=no"),
		]);
		const nextCommits =
			logResult.code === 0 ? parseGitGraphLog(logResult.stdout) : [];
		const nextBranches =
			branchResult.code === 0 ? parseGitGraphBranches(branchResult.stdout) : [];
		setCommits(nextCommits);
		setBranches(nextBranches);
		const statusLines = statusResult.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		setChangedFiles(Math.max(0, statusLines.length - 1));
		if (nextCommits.length === 0) {
			setError(
				logResult.stderr.trim() ||
					"No commits found. Open a Git repository to see its history."
			);
		}
		setLoading(false);
	}, [folder, git, selectedBranch]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const rows = useMemo(() => buildGitGraphRows(commits), [commits]);
	const normalizedQuery = query.trim().toLowerCase();
	const visibleRows = useMemo(
		() =>
			rows.filter(({ commit }) => {
				if (!normalizedQuery) {
					return true;
				}
				return [
					commit.subject,
					commit.author,
					commit.shortSha,
					...commit.refs,
				].some((value) => value.toLowerCase().includes(normalizedQuery));
			}),
		[normalizedQuery, rows]
	);

	useEffect(() => {
		if (
			!(
				selectedSha &&
				visibleRows.some(({ commit }) => commit.sha === selectedSha)
			)
		) {
			setSelectedSha(visibleRows[0]?.commit.sha ?? null);
		}
	}, [selectedSha, visibleRows]);

	const selectedCommit = useMemo(
		() => commits.find((commit) => commit.sha === selectedSha) ?? null,
		[commits, selectedSha]
	);
	const currentBranch = branches.find((branch) => branch.current);
	const folderLabel = folder
		? folder.split(/[\\/]/).at(-1) || folder
		: "Workspace";
	if (!folder) {
		return (
			<GraphEmptyState text="Open a project folder to see its Git graph." />
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			{!compact && (
				<div className="flex shrink-0 items-start justify-between gap-4 border-border/60 border-b px-5 py-4">
					<div className="min-w-0">
						<div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							<HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />
							<span>Workspace / Git</span>
						</div>
						<h1 className="truncate font-medium text-lg tracking-tight">
							Git graph
						</h1>
						<p className="mt-1 truncate text-muted-foreground text-xs">
							{tl(
								"{folderLabel} · follow branches, merges, and the commits behind your chats",
								{ folderLabel }
							)}
						</p>
					</div>
					<button
						aria-label="Refresh Git graph"
						className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						onClick={() => void refresh()}
						type="button"
					>
						<HugeiconsIcon
							className={cn("size-4", loading && "animate-spin")}
							icon={RefreshIcon}
						/>
					</button>
				</div>
			)}

			<div className="flex shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2">
				<div className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted/55 px-2.5 py-1 text-xs">
					<HugeiconsIcon
						className="size-3.5 text-primary"
						icon={GitBranchIcon}
					/>
					<span className="max-w-44 truncate font-medium">
						{selectedBranch ?? "All branches"}
					</span>
					<HugeiconsIcon className="size-3 opacity-50" icon={ArrowDown01Icon} />
				</div>
				<label className="flex min-w-40 flex-1 items-center gap-1.5 rounded-full bg-muted/35 px-2.5 py-1 text-muted-foreground focus-within:text-foreground focus-within:ring-1 focus-within:ring-ring">
					<HugeiconsIcon className="size-3.5 shrink-0" icon={Search01Icon} />
					<span className="sr-only">Filter commits</span>
					<input
						className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Filter commits"
						value={query}
					/>
				</label>
				<div className="type-caption ml-auto flex items-center gap-1.5 text-muted-foreground">
					<span className="rounded-full bg-muted/35 px-2 py-1">
						{tl("{count} commits", { count: String(commits.length) })}
					</span>
					<span className="rounded-full bg-muted/35 px-2 py-1">
						{tl("{count} refs", { count: String(branches.length) })}
					</span>
					{changedFiles > 0 && (
						<span className="rounded-full bg-muted/35 px-2 py-1">
							{tl("{count} changed", { count: String(changedFiles) })}
						</span>
					)}
				</div>
			</div>

			<div className="flex min-h-0 flex-1">
				<aside className="flex w-52 shrink-0 flex-col border-border/60 border-r bg-sidebar/35">
					<div className="flex items-center justify-between px-3 py-2.5">
						<span className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
							Refs
						</span>
						<span className="text-muted-foreground/60 text-xs">
							{branches.length}
						</span>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
						<BranchRefRow
							active={selectedBranch === null}
							label="All branches"
							onClick={() => setSelectedBranch(null)}
						/>
						{branches.map((branch) => (
							<BranchRefRow
								active={selectedBranch === branch.name}
								branch={branch}
								key={branch.name}
								label={branch.name}
								onClick={() => setSelectedBranch(branch.name)}
							/>
						))}
					</div>
				</aside>

				<main className="min-w-0 flex-1 overflow-y-auto">
					{loading && commits.length === 0 ? (
						<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
							Loading Git history…
						</div>
					) : error && commits.length === 0 ? (
						<GraphEmptyState text={error} />
					) : visibleRows.length === 0 ? (
						<GraphEmptyState text="No commits match this filter." />
					) : (
						<div className="min-w-[520px] px-2 py-2">
							{visibleRows.map((row) => (
								<GitGraphCommitRow
									key={row.commit.sha}
									laneCount={laneCount(rows)}
									onSelect={() => setSelectedSha(row.commit.sha)}
									row={row}
									selected={row.commit.sha === selectedSha}
								/>
							))}
						</div>
					)}
				</main>

				<aside className="hidden w-72 shrink-0 border-border/60 border-l bg-sidebar/25 xl:flex xl:flex-col">
					<CommitDetails
						changedFiles={changedFiles}
						commit={selectedCommit}
						currentBranch={currentBranch}
						folder={folder}
						onOpenChanges={() =>
							openTab(`/project/diff/${encodeURIComponent(folder)}`, {
								title: `Changes · ${folderLabel}`,
							})
						}
					/>
				</aside>
			</div>
		</div>
	);
}

function laneCount(rows: GitGraphRow[]): number {
	return Math.max(
		1,
		...rows
			.flatMap((row) => [row.lane, ...row.parentLanes])
			.map((lane) => lane + 1)
	);
}

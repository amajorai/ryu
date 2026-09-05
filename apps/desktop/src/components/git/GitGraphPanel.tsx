import {
	ArrowDown01Icon,
	GitBranchIcon,
	GitCommitIcon,
	RefreshIcon,
	Search01Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
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

interface GitCommandResult {
	code: number;
	stderr: string;
	stdout: string;
}

interface GitGraphPanelProps {
	compact?: boolean;
	folder?: string | null;
}

const LANE_COLORS = [
	"var(--primary)",
	"#60a5fa",
	"#f59e0b",
	"#e879f9",
	"#fb7185",
	"#2dd4bf",
] as const;

export function GitGraphPanel({ compact = false, folder }: GitGraphPanelProps) {
	const terminalShell = useWorkspaceStore((state) => state.terminalShell);
	const { openTab } = useTabsContext();
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
						<div className="mb-1 flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-[0.16em]">
							<HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />
							<span>Workspace / Git</span>
						</div>
						<h1 className="truncate font-medium text-lg tracking-tight">
							Git graph
						</h1>
						<p className="mt-1 truncate text-muted-foreground text-xs">
							{folderLabel} · follow branches, merges, and the commits behind
							your chats
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
				<label className="flex min-w-40 flex-1 items-center gap-1.5 rounded-full bg-muted/35 px-2.5 py-1 text-muted-foreground focus-within:text-foreground">
					<HugeiconsIcon className="size-3.5 shrink-0" icon={Search01Icon} />
					<span className="sr-only">Filter commits</span>
					<input
						className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Filter commits"
						value={query}
					/>
				</label>
				<div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<span className="rounded-full bg-muted/35 px-2 py-1">
						{commits.length} commits
					</span>
					<span className="rounded-full bg-muted/35 px-2 py-1">
						{branches.length} refs
					</span>
					{changedFiles > 0 && (
						<span className="rounded-full bg-muted/35 px-2 py-1">
							{changedFiles} changed
						</span>
					)}
				</div>
			</div>

			<div className="flex min-h-0 flex-1">
				<aside className="flex w-52 shrink-0 flex-col border-border/60 border-r bg-sidebar/35">
					<div className="flex items-center justify-between px-3 py-2.5">
						<span className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
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

function BranchRefRow({
	active,
	branch,
	label,
	onClick,
}: {
	active: boolean;
	branch?: GitGraphBranch;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				"group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
				active
					? "bg-muted text-foreground"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
			)}
			onClick={onClick}
			type="button"
		>
			<span
				className={cn(
					"relative flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-border/70",
					active && "ring-2 ring-primary/30"
				)}
			>
				<span
					className={cn(
						"size-1.5 rounded-full",
						active ? "bg-primary" : "bg-muted-foreground/50"
					)}
				/>
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{branch?.current && (
				<span className="text-[10px] text-primary">HEAD</span>
			)}
		</button>
	);
}

function GitGraphCommitRow({
	laneCount,
	onSelect,
	row,
	selected,
}: {
	laneCount: number;
	onSelect: () => void;
	row: GitGraphRow;
	selected: boolean;
}) {
	return (
		<button
			aria-pressed={selected}
			className={cn(
				"group flex min-h-14 w-full items-stretch rounded-lg text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
				selected && "bg-primary/[0.07]"
			)}
			onClick={onSelect}
			type="button"
		>
			<CommitLane laneCount={laneCount} row={row} selected={selected} />
			<span className="min-w-0 flex-1 py-2 pr-3">
				<span className="flex min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-medium text-xs",
							selected && "text-foreground"
						)}
					>
						{row.commit.subject}
					</span>
					{row.commit.refs.slice(0, 3).map((ref) => (
						<span
							className="hidden shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary sm:inline"
							key={ref}
						>
							{ref}
						</span>
					))}
				</span>
				<span className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
					<code className="font-mono text-foreground/70">
						{row.commit.shortSha}
					</code>
					<span aria-hidden="true">·</span>
					<span>{row.commit.author}</span>
					<span aria-hidden="true">·</span>
					<span>{row.commit.date}</span>
				</span>
			</span>
		</button>
	);
}

function CommitLane({
	laneCount,
	row,
	selected,
}: {
	laneCount: number;
	row: GitGraphRow;
	selected: boolean;
}) {
	const laneWidth = 22;
	const width = Math.max(48, laneCount * laneWidth + 18);
	const startX = row.lane * laneWidth + 10;
	return (
		<svg
			aria-hidden="true"
			className="h-14 shrink-0 overflow-visible"
			viewBox={`0 0 ${width} 56`}
			width={width}
		>
			{Array.from({ length: laneCount }, (_, lane) => {
				const x = lane * laneWidth + 10;
				return (
					<line
						key={`guide-${lane}`}
						opacity={lane === row.lane ? 0.35 : 0.12}
						stroke={laneColor(lane)}
						strokeWidth="1"
						x1={x}
						x2={x}
						y1="0"
						y2="56"
					/>
				);
			})}
			{row.parentLanes.map((parentLane, index) => {
				const endX = parentLane * laneWidth + 10;
				const path =
					endX === startX
						? `M ${startX} 28 L ${endX} 56`
						: `M ${startX} 28 C ${startX} 40, ${endX} 44, ${endX} 56`;
				return (
					<path
						className="transition-opacity"
						d={path}
						fill="none"
						key={`parent-${index}-${parentLane}`}
						opacity={0.85}
						stroke={laneColor(parentLane)}
						strokeLinecap="round"
						strokeWidth="1.5"
					/>
				);
			})}
			<circle
				cx={startX}
				cy="28"
				fill="var(--sidebar)"
				r={selected ? 5 : 4}
				stroke={laneColor(row.lane)}
				strokeWidth={selected ? 2 : 1.5}
			/>
		</svg>
	);
}

function CommitDetails({
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
									className="rounded-full bg-primary/10 px-2 py-1 text-[10px] text-primary"
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
								>
									{parent}
								</code>
							))}
						</div>
					</div>
				)}
				<div className="rounded-lg border border-border/60 bg-muted/25 p-3 text-muted-foreground leading-relaxed">
					{currentBranch
						? `HEAD is on ${currentBranch.name}. `
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
					className="mt-2 truncate text-center text-[10px] text-muted-foreground/60"
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

function GraphEmptyState({ text }: { text: string }) {
	return (
		<div className="flex h-full min-h-36 items-center justify-center p-4 text-center text-muted-foreground text-xs">
			{text}
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

function laneColor(index: number): string {
	return LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0];
}

// apps/desktop/src/components/chat/WorkspacePicker.tsx
//
// Unified composer workspace selector: folder ▸ branch ▸ run-mode as ONE trigger +
// ONE compact dropdown whose rows open submenus (the folder/branch/run-mode detail),
// mirroring the agent/model/thinking selector. Replaces the three separate chips
// (ProjectPicker · WorkspaceHeader · WorktreePicker).
//
// Trigger: the folder name, plus the branch (git repos only) with its working-tree
// +added/−removed line counts, plus the worktree label ONLY when the chat is running
// in a worktree (worktree active or worktree mode armed) — a plain "this folder" run
// adds nothing. Git + worktree state is polled here, folded from the old pickers; the
// Folder submenu reuses ProjectPickerContent.

import {
	Add01Icon,
	Folder03Icon,
	FolderTreeIcon,
	LaptopIcon,
	RefreshIcon,
	Search01Icon,
	Tick02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { WORKSPACE_SELECT_TRIGGER } from "@/components/agent-elements/input/composer-select.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	checkoutBranch,
	createBranch,
	fetchGitBranches,
	fetchGitStatus,
	fetchWorktreeDiff,
	fetchWorktreeStatus,
	type WorktreeStatus,
} from "@/src/lib/api/git.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";
import { CreateFolderDialog, ProjectPickerContent } from "./ProjectPicker.tsx";

interface WorkspacePickerProps {
	conversationId?: string | null;
	target: ApiTarget;
}

const POLL_INTERVAL_MS = 5000;
const PATH_SEP = /[\\/]/;

const NO_WORKTREE: WorktreeStatus = {
	active: false,
	branch: null,
	path: null,
	has_changes: false,
	changed_files: 0,
};

interface LineStat {
	deletions: number;
	insertions: number;
}

const NO_STAT: LineStat = { insertions: 0, deletions: 0 };

/** +added / −removed line counts, replacing the old dirty dot. Renders nothing
 *  when there is no change. */
function DiffStat({ stat }: { stat: LineStat }) {
	if (stat.insertions === 0 && stat.deletions === 0) {
		return null;
	}
	return (
		<span className="flex shrink-0 items-center gap-1 font-medium text-[11px] tabular-nums">
			{stat.insertions > 0 && (
				<span className="text-emerald-600 dark:text-emerald-400/90">
					+{stat.insertions}
				</span>
			)}
			{stat.deletions > 0 && (
				<span className="text-red-600/90 dark:text-red-400/90">
					−{stat.deletions}
				</span>
			)}
		</span>
	);
}

export function WorkspacePicker({
	target,
	conversationId,
}: WorkspacePickerProps) {
	const folder = useWorkspaceStore((s) => s.folder);
	const setFolder = useWorkspaceStore((s) => s.setFolder);
	const worktreeMode = useWorkspaceStore((s) => s.worktreeMode);
	const worktreeBranch = useWorkspaceStore((s) => s.worktreeBranch);
	const setWorktreeMode = useWorkspaceStore((s) => s.setWorktreeMode);
	const setWorktreeBranch = useWorkspaceStore((s) => s.setWorktreeBranch);
	const regenerateWorktreeBranch = useWorkspaceStore(
		(s) => s.regenerateWorktreeBranch
	);

	const [open, setOpen] = useState(false);
	// Create/browse dialogs live OUTSIDE the menu so they survive it closing on select.
	const [createFolderOpen, setCreateFolderOpen] = useState(false);
	const [createBranchOpen, setCreateBranchOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);

	const handleSelectBrowsed = useCallback(
		(selected: string) => {
			// Browsed paths come from Core's own listing; on a transient activation
			// failure keep the current folder rather than clearing it.
			setFolder(selected).catch(() => {
				// no-op
			});
		},
		[setFolder]
	);

	// Branch state.
	const [branch, setBranch] = useState<string | null>(null);
	const [folderStat, setFolderStat] = useState<LineStat>(NO_STAT);
	const [dirty, setDirty] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [loadingBranches, setLoadingBranches] = useState(false);
	const [switching, setSwitching] = useState<string | null>(null);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [creatingBranch, setCreatingBranch] = useState(false);

	// Worktree state.
	const [isRepo, setIsRepo] = useState(false);
	const [worktreeStatus, setWorktreeStatus] =
		useState<WorktreeStatus>(NO_WORKTREE);
	const [worktreeStat, setWorktreeStat] = useState<LineStat>(NO_STAT);
	const worktreeAbortRef = useRef<AbortController | null>(null);

	const folderName = folder ? folder.split(PATH_SEP).at(-1) : null;

	// Poll git status: branch + is_repo + working-tree line counts.
	useEffect(() => {
		if (!folder) {
			setBranch(null);
			setIsRepo(false);
			setFolderStat(NO_STAT);
			setDirty(false);
			return;
		}
		let active = true;
		const run = async () => {
			const status = await fetchGitStatus(target, folder);
			if (!active) {
				return;
			}
			setIsRepo(status.is_repo);
			if (status.is_repo) {
				setBranch(status.branch);
				setFolderStat({
					insertions: status.insertions,
					deletions: status.deletions,
				});
				setDirty(status.dirty);
			} else {
				setBranch(null);
				setFolderStat(NO_STAT);
				setDirty(false);
			}
		};
		run();
		const id = setInterval(run, POLL_INTERVAL_MS);
		return () => {
			active = false;
			clearInterval(id);
		};
	}, [folder, target]);

	// Poll this conversation's live worktree status + diff line totals.
	useEffect(() => {
		if (!(folder && conversationId)) {
			setWorktreeStatus(NO_WORKTREE);
			setWorktreeStat(NO_STAT);
			return;
		}
		let active = true;
		const run = async () => {
			worktreeAbortRef.current?.abort();
			const controller = new AbortController();
			worktreeAbortRef.current = controller;
			const next = await fetchWorktreeStatus(
				target,
				conversationId,
				controller.signal
			);
			if (!active) {
				return;
			}
			setWorktreeStatus(next);
			if (next.active && next.has_changes) {
				const diff = await fetchWorktreeDiff(
					target,
					conversationId,
					controller.signal
				);
				if (active) {
					setWorktreeStat(
						diff.files.reduce(
							(acc, f) => ({
								insertions: acc.insertions + f.additions,
								deletions: acc.deletions + f.deletions,
							}),
							NO_STAT
						)
					);
				}
			} else {
				setWorktreeStat(NO_STAT);
			}
		};
		run();
		const id = setInterval(run, POLL_INTERVAL_MS);
		return () => {
			active = false;
			clearInterval(id);
			worktreeAbortRef.current?.abort();
		};
	}, [folder, conversationId, target]);

	const loadBranches = useCallback(async () => {
		if (!folder) {
			return;
		}
		setLoadingBranches(true);
		setBranchError(null);
		const result = await fetchGitBranches(target, folder);
		setBranches(result.branches);
		if (result.current) {
			setBranch(result.current);
		}
		setLoadingBranches(false);
	}, [folder, target]);

	const onOpenChange = useCallback(
		(next: boolean) => {
			setOpen(next);
			if (next && folder && isRepo) {
				setBranchError(null);
				loadBranches().catch(() => undefined);
			}
		},
		[folder, isRepo, loadBranches]
	);

	const handleSwitchBranch = useCallback(
		async (nextBranch: string) => {
			if (!folder || nextBranch === branch) {
				return;
			}
			setSwitching(nextBranch);
			setBranchError(null);
			const result = await checkoutBranch(target, folder, nextBranch);
			setSwitching(null);
			if (result.success) {
				setBranch(result.branch ?? nextBranch);
			} else {
				setBranchError(result.error ?? "Failed to switch branch");
			}
		},
		[branch, folder, target]
	);

	// Create a new branch off HEAD and switch to it. Returns an error string for
	// the picker to show inline, or null on success (then closes the menu). Only
	// reachable when the working tree is clean (the UI disables it otherwise).
	const handleCreateBranch = useCallback(
		async (name: string): Promise<string | null> => {
			if (!folder) {
				return "No folder selected";
			}
			setCreatingBranch(true);
			const result = await createBranch(target, folder, name);
			setCreatingBranch(false);
			if (result.success) {
				setBranch(result.branch ?? name);
				loadBranches().catch(() => undefined);
				setOpen(false);
				return null;
			}
			return result.error ?? "Failed to create branch";
		},
		[folder, target, loadBranches]
	);

	// The worktree segment shows ONLY when the chat actually runs in a worktree:
	// a live worktree, or worktree mode armed for the next run. A plain "this
	// folder" run contributes no segment.
	const inWorktree = worktreeStatus.active || worktreeMode;
	const worktreeLabel = worktreeStatus.active
		? (worktreeStatus.branch ?? "worktree")
		: "New worktree";

	let runModeLabel = "This folder";
	if (worktreeStatus.active) {
		runModeLabel = "Worktree";
	} else if (worktreeMode) {
		runModeLabel = "New worktree";
	}

	return (
		<>
			<DropdownMenu onOpenChange={onOpenChange} open={open}>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label="Workspace: folder, branch and run mode"
							className={WORKSPACE_SELECT_TRIGGER}
							size="sm"
							title={folder ?? "Pick a project folder"}
							type="button"
							variant="ghost"
						/>
					}
				>
					<HugeiconsIcon className="size-3.5 shrink-0" icon={Folder03Icon} />
					<span className="max-w-32 truncate">{folderName ?? "Project"}</span>
					{folder && isRepo && branch && (
						<>
							<span className="text-muted-foreground/40">·</span>
							<HugeiconsIcon
								className="size-3.5 shrink-0"
								icon={WorkflowCircle06Icon}
							/>
							<span className="max-w-28 truncate">{branch}</span>
							<DiffStat stat={folderStat} />
						</>
					)}
					{folder && isRepo && inWorktree && (
						<>
							<span className="text-muted-foreground/40">·</span>
							<HugeiconsIcon
								className="size-3.5 shrink-0"
								icon={FolderTreeIcon}
							/>
							<span className="max-w-28 truncate">{worktreeLabel}</span>
							<DiffStat stat={worktreeStat} />
						</>
					)}
				</DropdownMenuTrigger>

				<DropdownMenuContent
					align="start"
					className="min-w-[280px]"
					side="top"
					sideOffset={6}
				>
					{/* Folder */}
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={Folder03Icon}
							/>
							<span className="flex-1 text-[13px] text-muted-foreground">
								Folder
							</span>
							<span className="max-w-[140px] truncate text-[13px]">
								{folderName ?? "None"}
							</span>
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="max-h-[60vh] w-64 overflow-y-auto">
							<ProjectPickerContent
								onBrowse={() => {
									setOpen(false);
									setBrowseOpen(true);
								}}
								onClose={() => setOpen(false)}
								onStartFromScratch={() => {
									setOpen(false);
									setCreateFolderOpen(true);
								}}
							/>
						</DropdownMenuSubContent>
					</DropdownMenuSub>

					{folder && isRepo && (
						<>
							{/* Branch */}
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={WorkflowCircle06Icon}
									/>
									<span className="flex-1 text-[13px] text-muted-foreground">
										Branch
									</span>
									<span className="flex items-center gap-1.5">
										<span className="max-w-[140px] truncate text-[13px]">
											{branch}
										</span>
										<DiffStat stat={folderStat} />
									</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="max-h-[60vh] min-w-[220px] overflow-y-auto">
									<BranchList
										branch={branch}
										branches={branches}
										dirty={dirty}
										error={branchError}
										loading={loadingBranches}
										onStartCreate={() => {
											setOpen(false);
											setCreateBranchOpen(true);
										}}
										onSwitch={handleSwitchBranch}
										switching={switching}
									/>
								</DropdownMenuSubContent>
							</DropdownMenuSub>

							{/* Run mode */}
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={inWorktree ? FolderTreeIcon : LaptopIcon}
									/>
									<span className="flex-1 text-[13px] text-muted-foreground">
										Run mode
									</span>
									<span className="max-w-[140px] truncate text-[13px]">
										{runModeLabel}
									</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="min-w-[280px]">
									<RunModeContent
										onRegenerate={regenerateWorktreeBranch}
										onSetBranch={setWorktreeBranch}
										onSetMode={setWorktreeMode}
										status={worktreeStatus}
										worktreeBranch={worktreeBranch}
										worktreeMode={worktreeMode}
									/>
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<CreateFolderDialog
				onOpenChange={setCreateFolderOpen}
				open={createFolderOpen}
			/>
			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={handleSelectBrowsed}
				open={browseOpen}
			/>
			<CreateBranchDialog
				creating={creatingBranch}
				onCreate={handleCreateBranch}
				onOpenChange={setCreateBranchOpen}
				open={createBranchOpen}
			/>
		</>
	);
}

function BranchList({
	branches,
	branch,
	loading,
	switching,
	error,
	dirty,
	onSwitch,
	onStartCreate,
}: {
	branches: string[];
	branch: string | null;
	loading: boolean;
	switching: string | null;
	error: string | null;
	/** Working tree has uncommitted changes — creating a branch is disabled. */
	dirty: boolean;
	onSwitch: (b: string) => void;
	/** Opens the create-branch dialog (owned by the persistent parent). */
	onStartCreate: () => void;
}) {
	const [query, setQuery] = useState("");

	if (loading) {
		return (
			<div className="flex justify-center py-4">
				<Spinner />
			</div>
		);
	}
	if (branches.length === 0) {
		return (
			<p className="px-2 py-1.5 text-muted-foreground text-sm">
				No branches found.
			</p>
		);
	}

	const q = query.trim().toLowerCase();
	const filtered = q
		? branches.filter((b) => b.toLowerCase().includes(q))
		: branches;

	// A dirty tree blocks branch creation, so the row is disabled with a tooltip;
	// otherwise it opens the create-branch dialog (which outlives this menu).
	const createRow = (
		<DropdownMenuItem disabled={dirty} onClick={onStartCreate}>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={Add01Icon}
			/>
			<span className="flex-1 text-[13px]">Create a new branch</span>
		</DropdownMenuItem>
	);

	return (
		<>
			{branches.length > 1 && (
				<div className="sticky top-0 z-10 mb-1 bg-muted/95 pb-1 backdrop-blur-2xl">
					<div className="relative">
						<HugeiconsIcon
							className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							className="h-7 border-transparent bg-transparent pl-7 text-[12px]"
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							placeholder="Search branches"
							spellCheck={false}
							value={query}
						/>
					</div>
				</div>
			)}
			{filtered.length === 0 ? (
				<p className="px-2 py-1.5 text-muted-foreground text-sm">
					No matching branches.
				</p>
			) : (
				filtered.map((b) => {
					const isActive = b === branch;
					return (
						<DropdownMenuItem
							className={cn(isActive && "bg-foreground/10")}
							disabled={switching !== null}
							key={b}
							onClick={() => onSwitch(b)}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={WorkflowCircle06Icon}
							/>
							<span className="min-w-0 flex-1 truncate text-[13px]">{b}</span>
							{switching === b ? (
								<Spinner className="size-4 shrink-0" />
							) : (
								isActive && (
									<HugeiconsIcon
										className="shrink-0 text-muted-foreground"
										icon={Tick02Icon}
										size={16}
										strokeWidth={2}
									/>
								)
							)}
						</DropdownMenuItem>
					);
				})
			)}
			{error && (
				<p className="mt-1 px-2 py-1.5 text-[12px] text-destructive">{error}</p>
			)}

			<DropdownMenuSeparator />
			{dirty ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger render={createRow} />
						<TooltipContent>Commit those changes first</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				createRow
			)}
		</>
	);
}

/** Dialog to name and create a new git branch off HEAD, then switch to it.
 *  Controlled + rendered by WorkspacePicker so it outlives the branch menu. */
function CreateBranchDialog({
	open: dialogOpen,
	onOpenChange,
	onCreate,
	creating,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Create a branch; resolves to an error string, or null on success. */
	onCreate: (name: string) => Promise<string | null>;
	creating: boolean;
}) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!trimmed || creating) {
			return;
		}
		setError(null);
		const err = await onCreate(trimmed);
		if (err) {
			setError(err);
		} else {
			setName("");
			onOpenChange(false);
		}
	}, [name, creating, onCreate, onOpenChange]);

	return (
		<Dialog onOpenChange={onOpenChange} open={dialogOpen}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Create a new branch</DialogTitle>
					<DialogDescription>
						Branch off the current HEAD and switch to it.
					</DialogDescription>
				</DialogHeader>
				<Input
					// biome-ignore lint/a11y/noAutofocus: dialog opened by explicit user action; focusing the sole field is expected
					autoFocus
					className="font-mono"
					disabled={creating}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleCreate();
						}
					}}
					placeholder="feature/my-branch"
					spellCheck={false}
					value={name}
				/>
				{error && <p className="text-[12px] text-destructive">{error}</p>}
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>
						Cancel
					</DialogClose>
					<Button
						disabled={creating || name.trim().length === 0}
						onClick={handleCreate}
						type="button"
					>
						{creating ? <Spinner className="size-4" /> : "Create branch"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RunModeContent({
	status,
	worktreeMode,
	worktreeBranch,
	onSetMode,
	onSetBranch,
	onRegenerate,
}: {
	status: WorktreeStatus;
	worktreeMode: boolean;
	worktreeBranch: string;
	onSetMode: (v: boolean) => void;
	onSetBranch: (v: string) => void;
	onRegenerate: () => void;
}) {
	if (status.active) {
		return (
			<div className="flex flex-col gap-2 px-1 py-1">
				<div className="flex items-center gap-2 px-1">
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={FolderTreeIcon}
					/>
					<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
						{status.branch}
					</span>
				</div>
				<p className="px-1 text-[12px] text-muted-foreground">
					{status.changed_files > 0
						? `${status.changed_files} changed file${status.changed_files === 1 ? "" : "s"}. Review and apply from the diff panel.`
						: "This chat runs in its own worktree. Changes are isolated until you apply them from the diff panel."}
				</p>
			</div>
		);
	}
	return (
		<>
			<ModeRow
				description="Edit the selected folder directly."
				icon={LaptopIcon}
				onSelect={() => onSetMode(false)}
				selected={!worktreeMode}
				title="Work in this folder"
			/>
			<ModeRow
				description="Run in a persistent git worktree, reused across this chat."
				icon={FolderTreeIcon}
				onSelect={() => onSetMode(true)}
				selected={worktreeMode}
				title="Isolated worktree"
			/>
			{worktreeMode && (
				<>
					<DropdownMenuSeparator />
					<div className="flex flex-col gap-1.5 px-1.5 pb-1">
						<span className="text-[11px] text-muted-foreground">
							Branch name
						</span>
						<div className="flex items-center gap-1.5">
							<Input
								className="h-7 flex-1 font-mono text-[12px]"
								onChange={(e) => onSetBranch(e.target.value)}
								onKeyDown={(e) => e.stopPropagation()}
								placeholder="ryu/my-feature"
								spellCheck={false}
								value={worktreeBranch}
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
				</>
			)}
		</>
	);
}

function ModeRow({
	title,
	description,
	icon,
	selected,
	onSelect,
}: {
	title: string;
	description: string;
	icon: typeof WorkflowCircle06Icon;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			className={cn(
				"flex w-full items-start gap-2 rounded-2xl px-1.5 py-1.5 text-left transition-colors hover:bg-foreground/10",
				selected && "bg-foreground/10"
			)}
			onClick={onSelect}
			type="button"
		>
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				icon={icon}
			/>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-[13px] text-foreground/80">
					{title}
				</span>
				<span className="block text-[11px] text-muted-foreground">
					{description}
				</span>
			</span>
			{selected && (
				<HugeiconsIcon
					className="mt-0.5 shrink-0 text-muted-foreground"
					icon={Tick02Icon}
					size={16}
					strokeWidth={2}
				/>
			)}
		</button>
	);
}

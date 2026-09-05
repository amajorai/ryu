// apps/desktop/src/components/chat/WorkspacePicker.tsx
//
// Composer workspace selector: three direct, evenly sized controls for project,
// run location, and branch. Each control opens its own menu immediately; none of
// the core workspace choices sit behind a submenu.
//
// Trigger: the folder name, plus the branch (git repos only) with its working-tree
// +added/−removed line counts, plus the worktree label ONLY when the chat is running
// in a worktree (worktree active or worktree mode armed) — a plain "this folder" run
// adds nothing. Git + worktree state is polled here, folded from the old pickers; the
// The project menu reuses ProjectPickerContent.
//
// `stacked` is the pinned summary panel's variant: the same three lists, but as
// three full-width rows each opening its own menu directly, instead of one inline
// chip whose submenus you have to walk. It exists so that panel has no reason to
// keep its own copy of these pickers — the narrow (288px) column cannot show the
// inline chip without truncating it to nothing.

import {
	Add01Icon,
	ArrowDown01Icon,
	ComputerTerminal01Icon,
	Folder03Icon,
	FolderTreeIcon,
	LaptopIcon,
	PlayIcon,
	RefreshIcon,
	Search01Icon,
	Tick02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
	WORKSPACE_MENU_CONTENT,
	WORKSPACE_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	invalidateGitStatus,
	useGitStatus,
	useWorktreeDiff,
	useWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import { useTerminalPanelLocation } from "@/src/hooks/useTerminalPanelLocation.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	checkoutBranch,
	createBranch,
	fetchGitBranches,
	type WorktreeStatus,
} from "@/src/lib/api/git.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useDockPanelRequestStore } from "@/src/store/useDockPanelRequestStore.ts";
import type {
	ProjectEnvironment,
	ProjectEnvironmentScripts,
} from "@/src/store/useWorkspaceStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";
import {
	CloneFolderDialog,
	CreateFolderDialog,
	ProjectPickerContent,
} from "./ProjectPicker.tsx";

interface WorkspacePickerProps {
	conversationId?: string | null;
	/**
	 * Render as three full-width rows (folder · branch · run mode), each opening
	 * its own menu, instead of one inline chip with submenus. For narrow columns
	 * — the pinned summary panel — where the inline chip has nowhere to go.
	 */
	folderOverride?: string | null;
	folderReadOnly?: boolean;
	/** Keep manual run-mode changes aligned with the active chat tab. */
	onWorktreeModeChange?: (enabled: boolean) => void;
	/** Hide insertion/deletion counts while retaining the branch and file summary. */
	showLineStats?: boolean;
	stacked?: boolean;
	target: ApiTarget;
	/** The active chat's per-tab run-mode choice, when one exists. */
	worktreeModeOverride?: boolean;
}

const PATH_SEP = /[\\/]/;

export interface LineStat {
	deletions: number;
	insertions: number;
}

const NO_STAT: LineStat = { insertions: 0, deletions: 0 };
const EMPTY_ENVIRONMENTS: ProjectEnvironment[] = [];

/** +added / −removed line counts, replacing the old dirty dot. Renders nothing
 *  when there is no change. Exported because the pinned summary panel shows the
 *  same counts in its accordion header — it used to carry a second copy of this
 *  component, which is how the two ended up sized differently. */
export function DiffStat({ stat }: { stat: LineStat }) {
	if (stat.insertions === 0 && stat.deletions === 0) {
		return null;
	}
	return (
		<span className="flex shrink-0 items-center gap-1 font-medium font-mono text-[11px] tabular-nums">
			{stat.insertions > 0 && (
				<span className="text-emerald-600 dark:text-emerald-400/90">
					+{formatCount(stat.insertions)}
				</span>
			)}
			{stat.deletions > 0 && (
				<span className="text-red-600/90 dark:text-red-400/90">
					−{formatCount(stat.deletions)}
				</span>
			)}
		</span>
	);
}

/** Which direct workspace menu is open. */
type WorkspacePickerId = "folder" | "branch" | "environment" | "mode";

function scriptForCurrentPlatform(scripts: ProjectEnvironmentScripts): string {
	const platform = navigator.platform.toLowerCase();
	const override = platform.includes("mac")
		? scripts.macos
		: platform.includes("win")
			? scripts.windows
			: platform.includes("linux")
				? scripts.linux
				: "";
	return override.trim() || scripts.default.trim();
}

export function WorkspacePicker({
	target,
	conversationId,
	folderOverride,
	folderReadOnly = false,
	onWorktreeModeChange,
	showLineStats = true,
	stacked = false,
	worktreeModeOverride,
}: WorkspacePickerProps) {
	const { canUseNativeShell } = useAppSurface();
	const storeFolder = useWorkspaceStore((s) => s.folder);
	const folder = folderOverride === undefined ? storeFolder : folderOverride;
	const projectNames = useWorkspaceStore((s) => s.projectNames);
	const projects = useWorkspaceStore((s) => s.projects);
	const setFolder = useWorkspaceStore((s) => s.setFolder);
	const globalWorktreeMode = useWorkspaceStore((s) => s.worktreeMode);
	const worktreeBranch = useWorkspaceStore((s) => s.worktreeBranch);
	const setWorktreeMode = useWorkspaceStore((s) => s.setWorktreeMode);
	const setWorktreeBranch = useWorkspaceStore((s) => s.setWorktreeBranch);
	const regenerateWorktreeBranch = useWorkspaceStore(
		(s) => s.regenerateWorktreeBranch
	);
	const projectEnvironments = useWorkspaceStore((s) =>
		folder
			? (s.projectEnvironments[folder] ?? EMPTY_ENVIRONMENTS)
			: EMPTY_ENVIRONMENTS
	);
	const activeEnvironmentId = useWorkspaceStore((s) =>
		folder ? s.activeProjectEnvironments[folder] : undefined
	);
	const selectProjectEnvironment = useWorkspaceStore(
		(s) => s.selectProjectEnvironment
	);
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const [terminalPanelLocation] = useTerminalPanelLocation();
	const activeEnvironment = projectEnvironments.find(
		(environment) => environment.id === activeEnvironmentId
	);
	const worktreeMode = worktreeModeOverride ?? globalWorktreeMode;

	// Both layouts use one direct menu per control. Tracking the active control
	// keeps sibling menus mutually exclusive without nesting any of them.
	const [pickerOpen, setPickerOpen] = useState<WorkspacePickerId | null>(null);
	// Create/browse dialogs live OUTSIDE the menu so they survive it closing on select.
	const [createFolderOpen, setCreateFolderOpen] = useState(false);
	const [createBranchOpen, setCreateBranchOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [cloneFolderOpen, setCloneFolderOpen] = useState(false);

	const handleSelectBrowsed = useCallback(
		(selected: string) => {
			if (folderReadOnly) {
				return;
			}
			// Browsed paths come from Core's own listing; on a transient activation
			// failure keep the current folder rather than clearing it.
			setFolder(selected).catch(() => {
				// no-op
			});
		},
		[folderReadOnly, setFolder]
	);

	// Branch state. Branch / dirty / line counts all come from the shared git
	// query, so this picker and the panels around it always show one answer.
	const { status: gitStatus } = useGitStatus(target, folder);
	const isRepo = gitStatus.is_repo;
	const branch = gitStatus.is_repo ? gitStatus.branch : null;
	const dirty = gitStatus.is_repo && gitStatus.dirty;
	const folderStat: LineStat = gitStatus.is_repo
		? { insertions: gitStatus.insertions, deletions: gitStatus.deletions }
		: NO_STAT;
	const [branches, setBranches] = useState<string[]>([]);
	const [loadingBranches, setLoadingBranches] = useState(false);
	const [switching, setSwitching] = useState<string | null>(null);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [creatingBranch, setCreatingBranch] = useState(false);

	// Worktree state — both the status and the per-file diff ride the shared
	// queries every git surface reads, so this chip, the pinned panel's Changes
	// section and the Artifacts list can never quote three different totals.
	const worktreeStatus = useWorktreeStatus(
		target,
		folder ? conversationId : null
	);
	// Only asked for while a live worktree actually has changes: the diff read is
	// heavier than the status read, and with nothing to show the answer is NO_STAT
	// either way.
	const worktreeDiff = useWorktreeDiff(
		target,
		worktreeStatus.active && worktreeStatus.has_changes ? conversationId : null
	);
	const worktreeStat: LineStat = useMemo(
		() =>
			worktreeDiff.files.reduce(
				(acc, f) => ({
					insertions: acc.insertions + f.additions,
					deletions: acc.deletions + f.deletions,
				}),
				NO_STAT
			),
		[worktreeDiff.files]
	);

	// A renamed project shows its name, not its path leaf — the same resolution
	// the folder list itself uses, so the trigger and the row it selected agree.
	const activeProject = folder
		? findWorkspaceProject(projects, folder)
		: undefined;
	const folderName = activeProject
		? workspaceProjectName(activeProject, projectNames)
		: folder
			? projectNames[folder]?.trim() || folder.split(PATH_SEP).at(-1) || null
			: null;

	const loadBranches = useCallback(async () => {
		if (!folder) {
			return;
		}
		setLoadingBranches(true);
		setBranchError(null);
		const result = await fetchGitBranches(target, folder);
		setBranches(result.branches);
		if (result.current) {
			// Let the shared query pick the current branch up, so every surface
			// updates together instead of only this picker.
			invalidateGitStatus(folder);
		}
		setLoadingBranches(false);
	}, [folder, target]);

	/** Close whichever menu is open, in either variant. */
	const closeMenus = useCallback(() => {
		setPickerOpen(null);
	}, []);

	// One control opening closes the others. Branch data loads only when its direct
	// menu opens, so the project and run-location controls stay cheap.
	const onPickerOpenChange = useCallback(
		(id: WorkspacePickerId, next: boolean) => {
			setPickerOpen(next ? id : null);
			if (next && id === "branch" && folder && isRepo) {
				setBranchError(null);
				loadBranches().catch(() => undefined);
			}
		},
		[folder, isRepo, loadBranches]
	);
	const handleSetWorktreeMode = useCallback(
		(enabled: boolean) => {
			setWorktreeMode(enabled);
			onWorktreeModeChange?.(enabled);
		},
		[onWorktreeModeChange, setWorktreeMode]
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
				invalidateGitStatus(folder);
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
				invalidateGitStatus(folder);
				loadBranches().catch(() => undefined);
				closeMenus();
				return null;
			}
			return result.error ?? "Failed to create branch";
		},
		[folder, target, loadBranches, closeMenus]
	);

	// The worktree segment shows ONLY when the chat actually runs in a worktree:
	// a live worktree, or worktree mode armed for the next run. A plain "this
	// folder" run contributes no segment.
	const inWorktree = worktreeStatus.active || worktreeMode;
	const worktreeLabel = worktreeStatus.active
		? (worktreeStatus.branch ?? "worktree")
		: "New worktree";

	// The three menu bodies are shared by the inline composer and stacked summary
	// layouts. Both variants open them directly from the control that names them.
	const folderBody = (
		<ProjectPickerContent
			onBrowse={() => {
				closeMenus();
				setBrowseOpen(true);
			}}
			onClone={() => {
				closeMenus();
				setCloneFolderOpen(true);
			}}
			onClose={closeMenus}
			onStartFromScratch={() => {
				closeMenus();
				setCreateFolderOpen(true);
			}}
		/>
	);
	const branchBody = (
		<BranchList
			branch={branch}
			branches={branches}
			changedFiles={gitStatus.changed_files_count}
			dirty={dirty}
			error={branchError}
			loading={loadingBranches}
			onStartCreate={() => {
				closeMenus();
				setCreateBranchOpen(true);
			}}
			onSwitch={handleSwitchBranch}
			projectName={folderName}
			switching={switching}
		/>
	);
	const runModeBody = (
		<RunModeContent
			onRegenerate={regenerateWorktreeBranch}
			onSetBranch={setWorktreeBranch}
			onSetMode={handleSetWorktreeMode}
			status={worktreeStatus}
			worktreeBranch={worktreeBranch}
			worktreeMode={worktreeMode}
		/>
	);
	const environmentBody = folder ? (
		<EnvironmentList
			activeId={activeEnvironmentId}
			disabled={worktreeStatus.active}
			environments={projectEnvironments}
			onSelect={(environmentId) => {
				selectProjectEnvironment(folder, environmentId);
				closeMenus();
			}}
		/>
	) : null;

	const runEnvironmentAction = useCallback(
		(environment: ProjectEnvironment, actionId: string) => {
			const action = environment.actions.find((item) => item.id === actionId);
			const actionCwd = worktreeStatus.path ?? folder;
			if (!(action && actionCwd)) {
				return;
			}
			const command = scriptForCurrentPlatform(action.scripts);
			if (!command) {
				toast.error(`${action.name} has no command for this platform`);
				return;
			}
			const env = Object.fromEntries(
				environment.variables
					.filter((variable) => variable.key.trim())
					.map((variable) => [variable.key.trim(), variable.value])
			);
			env.RYU_PROJECT_PATH = folder ?? actionCwd;
			env.RYU_WORKTREE_PATH = actionCwd;
			useDockPanelRequestStore
				.getState()
				.open("terminal", "Terminal", terminalPanelLocation, {
					command,
					cwd: actionCwd,
					env,
					shell: terminalShell === "auto" ? null : terminalShell,
				});
			closeMenus();
		},
		[
			closeMenus,
			folder,
			terminalPanelLocation,
			terminalShell,
			worktreeStatus.path,
		]
	);

	if (stacked) {
		return (
			<>
				<div className="flex flex-col items-stretch gap-0.5">
					{folderReadOnly ? (
						<ReadonlyPickerRow
							fullWidth
							label={folderName ?? "No project folder"}
							title={folder ?? "No project folder selected"}
						/>
					) : (
						<PickerRow
							contentClassName="max-h-[60vh] overflow-y-auto"
							fullWidth
							icon={Folder03Icon}
							id="folder"
							label={folderName ?? "Project"}
							onOpenChange={onPickerOpenChange}
							open={pickerOpen === "folder"}
							side="bottom"
							title={folder ?? "Pick a project folder"}
						>
							{folderBody}
						</PickerRow>
					)}
					{folder && isRepo && (
						<PickerRow
							fullWidth
							icon={inWorktree ? FolderTreeIcon : LaptopIcon}
							id="mode"
							label={inWorktree ? worktreeLabel : "Local"}
							onOpenChange={onPickerOpenChange}
							open={pickerOpen === "mode"}
							side="bottom"
							title="Choose where this chat works"
							trailing={
								showLineStats && worktreeStatus.active ? (
									<DiffStat stat={worktreeStat} />
								) : null
							}
						>
							{runModeBody}
						</PickerRow>
					)}
					{canUseNativeShell && folder && projectEnvironments.length > 0 && (
						<PickerRow
							fullWidth
							icon={ComputerTerminal01Icon}
							id="environment"
							label={activeEnvironment?.name ?? "Environment"}
							onOpenChange={onPickerOpenChange}
							open={pickerOpen === "environment"}
							side="bottom"
							title="Choose this project's local environment"
						>
							{environmentBody}
						</PickerRow>
					)}
					{folder && isRepo && branch && (
						<PickerRow
							contentClassName="max-h-[60vh] overflow-y-auto"
							fullWidth
							icon={WorkflowCircle06Icon}
							id="branch"
							label={branch}
							onOpenChange={onPickerOpenChange}
							open={pickerOpen === "branch"}
							side="bottom"
							title={`Branch: ${branch}`}
							trailing={showLineStats ? <DiffStat stat={folderStat} /> : null}
						>
							{branchBody}
						</PickerRow>
					)}
				</div>
				<CreateFolderDialog
					onOpenChange={setCreateFolderOpen}
					open={createFolderOpen}
				/>
				<CloneFolderDialog
					onOpenChange={setCloneFolderOpen}
					open={cloneFolderOpen}
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

	return (
		<>
			<div className="flex min-w-0 items-center gap-0.5">
				{folderReadOnly ? (
					<ReadonlyPickerRow
						label={folderName ?? "No project folder"}
						title={folder ?? "No project folder selected"}
					/>
				) : (
					<PickerRow
						contentClassName="max-h-[60vh] overflow-y-auto"
						icon={Folder03Icon}
						id="folder"
						label={folderName ?? "Project"}
						onOpenChange={onPickerOpenChange}
						open={pickerOpen === "folder"}
						side="top"
						title={folder ?? "Pick a project folder"}
					>
						{folderBody}
					</PickerRow>
				)}
				{folder && isRepo && (
					<PickerRow
						icon={inWorktree ? FolderTreeIcon : LaptopIcon}
						id="mode"
						label={inWorktree ? worktreeLabel : "Local"}
						onOpenChange={onPickerOpenChange}
						open={pickerOpen === "mode"}
						side="top"
						title="Choose where this chat works"
						trailing={
							showLineStats && worktreeStatus.active ? (
								<DiffStat stat={worktreeStat} />
							) : null
						}
					>
						{runModeBody}
					</PickerRow>
				)}
				{canUseNativeShell && folder && projectEnvironments.length > 0 && (
					<PickerRow
						icon={ComputerTerminal01Icon}
						id="environment"
						label={activeEnvironment?.name ?? "Environment"}
						onOpenChange={onPickerOpenChange}
						open={pickerOpen === "environment"}
						side="top"
						title="Choose this project's local environment"
					>
						{environmentBody}
					</PickerRow>
				)}
				{folder && isRepo && branch && (
					<PickerRow
						contentClassName="max-h-[60vh] overflow-y-auto"
						icon={WorkflowCircle06Icon}
						id="branch"
						label={branch}
						onOpenChange={onPickerOpenChange}
						open={pickerOpen === "branch"}
						side="top"
						title={`Branch: ${branch}`}
						trailing={showLineStats ? <DiffStat stat={folderStat} /> : null}
					>
						{branchBody}
					</PickerRow>
				)}
				{canUseNativeShell
					? activeEnvironment?.actions.map((action) => (
							<Button
								className={WORKSPACE_SELECT_TRIGGER}
								key={action.id}
								onClick={() => {
									runEnvironmentAction(activeEnvironment, action.id);
								}}
								size="sm"
								title={`Run ${action.name} in ${worktreeStatus.path ? "the worktree" : "the project"}`}
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={PlayIcon} />
								<ButtonLabel className="max-w-28">{action.name}</ButtonLabel>
							</Button>
						))
					: null}
			</div>
			<CreateFolderDialog
				onOpenChange={setCreateFolderOpen}
				open={createFolderOpen}
			/>
			<CloneFolderDialog
				onOpenChange={setCloneFolderOpen}
				open={cloneFolderOpen}
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

function ReadonlyPickerRow({
	fullWidth = false,
	label,
	title,
}: {
	fullWidth?: boolean;
	label: string;
	title: string;
}) {
	return (
		<div
			aria-label={`Project folder: ${label}`}
			className={cn(
				WORKSPACE_SELECT_TRIGGER,
				"flex cursor-default items-center text-muted-foreground",
				fullWidth && "w-full justify-start"
			)}
			data-testid="pinned-summary-folder"
			title={title}
		>
			<HugeiconsIcon className="size-3.5 shrink-0" icon={Folder03Icon} />
			<span className="min-w-0 flex-1 truncate text-left">{label}</span>
		</div>
	);
}

function EnvironmentList({
	activeId,
	disabled,
	environments,
	onSelect,
}: {
	activeId?: string;
	disabled: boolean;
	environments: ProjectEnvironment[];
	onSelect: (environmentId: string) => void;
}) {
	return (
		<>
			<DropdownMenuLabel className="px-2 pt-1 pb-1 text-sm">
				Local environment
			</DropdownMenuLabel>
			{environments.map((environment) => (
				<DropdownMenuItem
					className={cn(activeId === environment.id && "bg-foreground/10")}
					disabled={disabled}
					key={environment.id}
					onClick={() => onSelect(environment.id)}
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={ComputerTerminal01Icon}
					/>
					<span className="min-w-0 flex-1 truncate">{environment.name}</span>
					{activeId === environment.id ? (
						<HugeiconsIcon className="size-4" icon={Tick02Icon} />
					) : null}
				</DropdownMenuItem>
			))}
			{disabled ? (
				<p className="px-2 py-1.5 text-muted-foreground text-xs">
					This chat already has a worktree. Switch environments before the next
					worktree is created.
				</p>
			) : null}
		</>
	);
}

/** One stacked row: a full-width trigger over its own menu. The three rows are
 *  three menus, not one menu with submenus, so a click lands on the list it
 *  names — the same one-click reach the panel's old separate pickers had. */
function PickerRow({
	children,
	contentClassName,
	fullWidth = false,
	icon,
	id,
	label,
	onOpenChange,
	open,
	side,
	title,
	trailing,
}: {
	children: ReactNode;
	contentClassName?: string;
	fullWidth?: boolean;
	icon: typeof WorkflowCircle06Icon;
	id: WorkspacePickerId;
	label: string;
	onOpenChange: (id: WorkspacePickerId, next: boolean) => void;
	open: boolean;
	side: "bottom" | "top";
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<DropdownMenu onOpenChange={(next) => onOpenChange(id, next)} open={open}>
			<DropdownMenuTrigger
				render={
					<Button
						className={cn(
							WORKSPACE_SELECT_TRIGGER,
							fullWidth && "w-full justify-start"
						)}
						size="sm"
						title={title}
						type="button"
						variant="ghost"
					/>
				}
			>
				<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
				<ButtonLabel className="flex-1 text-left">{label}</ButtonLabel>
				{trailing}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className={cn(WORKSPACE_MENU_CONTENT, contentClassName)}
				side={side}
				sideOffset={6}
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// How many branches the list renders before it stops and offers "show all". A
// repo with hundreds of branches would otherwise mount hundreds of menu rows on
// every open — and nobody scrolls past the first screen anyway. Core sorts by
// most-recent commit, so the visible head is the branches actually in play; the
// search box filters the FULL list, so a capped-away branch is always one query
// away (filter first, cap the filtered result — capping first would hide rows
// from search, which is the trap this affordance exists to avoid).
const BRANCH_PAGE = 50;

function BranchList({
	branches,
	branch,
	changedFiles,
	loading,
	switching,
	error,
	dirty,
	onSwitch,
	onStartCreate,
	projectName,
}: {
	branches: string[];
	branch: string | null;
	changedFiles: number;
	loading: boolean;
	switching: string | null;
	error: string | null;
	/** Working tree has uncommitted changes — creating a branch is disabled. */
	dirty: boolean;
	onSwitch: (b: string) => void;
	/** Opens the create-branch dialog (owned by the persistent parent). */
	onStartCreate: () => void;
	projectName: string | null;
}) {
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);

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
	const visible = showAll ? filtered : filtered.slice(0, BRANCH_PAGE);
	const hidden = filtered.length - visible.length;

	// A dirty tree blocks branch creation, so the row is disabled with a tooltip;
	// otherwise it opens the create-branch dialog (which outlives this menu).
	const createRow = (
		<DropdownMenuItem disabled={dirty} onClick={onStartCreate}>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={Add01Icon}
			/>
			<span className="flex-1">Create a new branch</span>
		</DropdownMenuItem>
	);

	return (
		<>
			{branches.length > 1 && (
				<div className="sticky top-0 z-10 mb-1">
					<div className="relative">
						<HugeiconsIcon
							className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							className="h-7 border-0 bg-transparent pl-7 text-[12px]"
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							placeholder={
								projectName
									? `Search ${projectName} branches`
									: "Search branches"
							}
							spellCheck={false}
							value={query}
						/>
					</div>
				</div>
			)}
			<DropdownMenuLabel className="px-2 pt-1 pb-1 text-sm">
				Branches
			</DropdownMenuLabel>
			{filtered.length === 0 ? (
				<p className="px-2 py-1.5 text-muted-foreground text-sm">
					No matching branches.
				</p>
			) : (
				visible.map((b) => {
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
							<span className="min-w-0 flex-1">
								<span className="block truncate">{b}</span>
								{isActive && changedFiles > 0 && (
									<span className="block truncate font-normal text-muted-foreground text-xs">
										Uncommitted: {formatCount(changedFiles)} file
										{changedFiles === 1 ? "" : "s"}
									</span>
								)}
							</span>
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
			{hidden > 0 && (
				<DropdownMenuItem closeOnClick={false} onClick={() => setShowAll(true)}>
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
					/>
					<span className="flex-1 text-muted-foreground">
						Show {hidden} more branch{hidden === 1 ? "" : "es"}
					</span>
				</DropdownMenuItem>
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
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button
						disabled={name.trim().length === 0}
						loading={creating}
						onClick={handleCreate}
						type="button"
					>
						Create branch
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
					<span className="min-w-0 flex-1 truncate">{status.branch}</span>
				</div>
				<p className="px-1 text-[12px] text-muted-foreground">
					{status.changed_files > 0
						? `${formatCount(status.changed_files)} changed file${status.changed_files === 1 ? "" : "s"}. Review and apply from the diff panel.`
						: "This chat runs in its own worktree. Changes are isolated until you apply them from the diff panel."}
				</p>
			</div>
		);
	}
	return (
		<>
			<DropdownMenuLabel className="px-2 pt-1 pb-1 text-sm">
				Work in
			</DropdownMenuLabel>
			<ModeRow
				icon={LaptopIcon}
				onSelect={() => onSetMode(false)}
				selected={!worktreeMode}
				title="Local"
			/>
			<ModeRow
				icon={FolderTreeIcon}
				onSelect={() => onSetMode(true)}
				selected={worktreeMode}
				title="New worktree"
			/>
			{worktreeMode && (
				<div className="flex flex-col gap-1.5 px-1.5 pb-1">
					<span className="text-[11px] text-muted-foreground">Branch name</span>
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
			)}
		</>
	);
}

function ModeRow({
	title,
	icon,
	selected,
	onSelect,
}: {
	title: string;
	icon: typeof WorkflowCircle06Icon;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem
			className={cn(selected && "bg-foreground/10")}
			onClick={onSelect}
		>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={icon}
			/>
			<span className="min-w-0 flex-1 truncate">{title}</span>
			{selected && (
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={Tick02Icon}
					size={16}
					strokeWidth={2}
				/>
			)}
		</DropdownMenuItem>
	);
}

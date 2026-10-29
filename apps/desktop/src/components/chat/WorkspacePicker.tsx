// apps/desktop/src/components/chat/WorkspacePicker.tsx
//
// Composer workspace selector: direct, evenly sized controls for project, run
// location, environment, and branch. Project, run location, and branch each open
// a searchable command dialog; the short environment list opens a direct menu.
// None of the core workspace choices sit behind a submenu.
//
// Trigger: the folder name, plus the branch (git repos only) with its working-tree
// +added/−removed line counts, plus the worktree label ONLY when the chat is running
// in a worktree (worktree active or worktree mode armed) — a plain "this folder" run
// adds nothing. Git + worktree state is polled here, folded from the old pickers.
// The project control reuses ProjectCommandDialog.
//
// `stacked` is the pinned summary panel's variant: the same controls, but as
// full-width rows each opening its own picker directly, instead of one inline
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
	Tick02Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandLoading,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
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
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import { WORKSPACE_SELECT_TRIGGER } from "@/components/agent-elements/input/composer-select.ts";
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
	ProjectCommandDialog,
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
		<span className="type-caption flex shrink-0 items-center gap-1 font-medium font-mono tabular-nums">
			{stat.insertions > 0 && (
				<span className="text-status-success dark:text-status-success/90">
					+{formatCount(stat.insertions)}
				</span>
			)}
			{stat.deletions > 0 && (
				<span className="text-status-destructive/90 dark:text-status-destructive/90">
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
			setPickerOpen((current) => (next ? id : current === id ? null : current));
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
				closeMenus();
			} else {
				setBranchError(result.error ?? "Failed to switch branch");
			}
		},
		[branch, closeMenus, folder, target]
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

	// The folder, run-location and branch controls each open a command dialog;
	// the environment list stays a small direct menu. Both layouts share them.
	const side = stacked ? "bottom" : "top";
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

	return (
		<>
			<div
				className={
					stacked
						? "flex flex-col items-stretch gap-0.5"
						: "flex min-w-0 items-center gap-0.5"
				}
			>
				{folderReadOnly ? (
					<ReadonlyPickerRow
						fullWidth={stacked}
						label={folderName ?? "No project folder"}
						title={folder ?? "No project folder selected"}
					/>
				) : (
					<PickerTrigger
						fullWidth={stacked}
						icon={Folder03Icon}
						label={folderName ?? "Project"}
						onOpen={() => onPickerOpenChange("folder", true)}
						open={pickerOpen === "folder"}
						title={folder ?? "Pick a project folder"}
					/>
				)}
				{folder && isRepo && (
					<PickerTrigger
						fullWidth={stacked}
						icon={inWorktree ? FolderTreeIcon : LaptopIcon}
						label={inWorktree ? worktreeLabel : "Local"}
						onOpen={() => onPickerOpenChange("mode", true)}
						open={pickerOpen === "mode"}
						title="Choose where this chat works"
						trailing={
							showLineStats && worktreeStatus.active ? (
								<DiffStat stat={worktreeStat} />
							) : null
						}
					/>
				)}
				{canUseNativeShell && folder && projectEnvironments.length > 0 && (
					<PickerRow
						fullWidth={stacked}
						icon={ComputerTerminal01Icon}
						id="environment"
						label={activeEnvironment?.name ?? "Environment"}
						onOpenChange={onPickerOpenChange}
						open={pickerOpen === "environment"}
						side={side}
						title="Choose this project's local environment"
					>
						{environmentBody}
					</PickerRow>
				)}
				{folder && isRepo && branch && (
					<PickerTrigger
						fullWidth={stacked}
						icon={WorkflowCircle06Icon}
						label={branch}
						onOpen={() => onPickerOpenChange("branch", true)}
						open={pickerOpen === "branch"}
						title={`Branch: ${branch}`}
						trailing={showLineStats ? <DiffStat stat={folderStat} /> : null}
					/>
				)}
				{!stacked && canUseNativeShell
					? activeEnvironment?.actions.map((action) => (
							<Button
								appearance="composer-settings-foreground"
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
			{!folderReadOnly && (
				<ProjectCommandDialog
					onBrowse={() => setBrowseOpen(true)}
					onClone={() => setCloneFolderOpen(true)}
					onOpenChange={(next) => onPickerOpenChange("folder", next)}
					onStartFromScratch={() => setCreateFolderOpen(true)}
					open={pickerOpen === "folder"}
				/>
			)}
			<PickerCommandDialog
				description="Work directly in this folder, or isolate the chat in a new Git worktree."
				onOpenChange={(next) => onPickerOpenChange("mode", next)}
				open={pickerOpen === "mode"}
				title="Choose where this chat works"
			>
				<RunModeContent
					onClose={closeMenus}
					onRegenerate={regenerateWorktreeBranch}
					onSetBranch={setWorktreeBranch}
					onSetMode={handleSetWorktreeMode}
					status={worktreeStatus}
					worktreeBranch={worktreeBranch}
					worktreeMode={worktreeMode}
				/>
			</PickerCommandDialog>
			<PickerCommandDialog
				description="Search this project's branches, switch to one, or create a new branch."
				onOpenChange={(next) => onPickerOpenChange("branch", next)}
				open={pickerOpen === "branch"}
				title="Switch branch"
			>
				<BranchList
					branch={branch}
					branches={branches}
					changedFiles={gitStatus.changed_files_count}
					dirty={dirty}
					error={branchError}
					loading={loadingBranches}
					onClose={closeMenus}
					onStartCreate={() => {
						closeMenus();
						setCreateBranchOpen(true);
					}}
					onSwitch={handleSwitchBranch}
					projectName={folderName}
					switching={switching}
				/>
			</PickerCommandDialog>
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
		<DropdownMenuGroup>
			<DropdownMenuLabel variant="worktree-heading">
				Local environment
			</DropdownMenuLabel>
			{environments.map((environment) => (
				<DropdownMenuItem
					active={activeId === environment.id}
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
		</DropdownMenuGroup>
	);
}

/** A workspace control that opens a command dialog rather than a menu. */
function PickerTrigger({
	fullWidth = false,
	icon,
	label,
	onOpen,
	open,
	title,
	trailing,
}: {
	fullWidth?: boolean;
	icon: typeof WorkflowCircle06Icon;
	label: string;
	onOpen: () => void;
	open: boolean;
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<Button
			appearance="composer-settings-foreground"
			aria-expanded={open}
			aria-haspopup="dialog"
			className={cn(fullWidth && "w-full justify-start")}
			onClick={onOpen}
			size="sm"
			title={title}
			type="button"
			variant="ghost"
		>
			<HugeiconsIcon className="size-3.5 shrink-0" icon={icon} />
			<ButtonLabel className="flex-1 text-left">{label}</ButtonLabel>
			{trailing}
		</Button>
	);
}

/** Command-dialog shell for the branch and run-location pickers. Filtering is
 *  manual (each body owns its query) so fixed actions stay reachable. */
function PickerCommandDialog({
	children,
	description,
	onOpenChange,
	open,
	title,
}: {
	children: ReactNode;
	description: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}) {
	return (
		<CommandDialog
			className="sm:max-w-lg"
			description={description}
			onOpenChange={onOpenChange}
			open={open}
			title={title}
		>
			<Command shouldFilter={false}>{children}</Command>
		</CommandDialog>
	);
}

/** The environment control: a trigger over its own small menu, so a click lands
 *  on the list it names with no submenu to walk. */
function PickerRow({
	children,
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
						appearance="composer-settings-foreground"
						className={cn(fullWidth && "w-full justify-start")}
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
				className="min-w-[280px]"
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
	onClose,
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
	onClose: () => void;
	onSwitch: (b: string) => void;
	/** Opens the create-branch dialog (owned by the persistent parent). */
	onStartCreate: () => void;
	projectName: string | null;
}) {
	const dirtyReasonId = useId();
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);

	if (loading) {
		return (
			<CommandList>
				<CommandLoading label="Loading branches">
					<SkeletonRows spacing="spacious" />
				</CommandLoading>
			</CommandList>
		);
	}
	if (branches.length === 0) {
		return (
			<CommandList>
				<CommandEmpty>No branches found.</CommandEmpty>
			</CommandList>
		);
	}

	const q = query.trim().toLowerCase();
	const filtered = q
		? branches.filter((b) => b.toLowerCase().includes(q))
		: branches;
	const visible = showAll ? filtered : filtered.slice(0, BRANCH_PAGE);
	const hidden = filtered.length - visible.length;

	return (
		<>
			{branches.length > 1 && (
				<CommandInput
					onValueChange={setQuery}
					placeholder={
						projectName ? `Search ${projectName} branches` : "Search branches"
					}
					spellCheck={false}
					value={query}
				/>
			)}
			{/* Status and error text stay outside the listbox, which may only own
			    options and groups. The create-branch row keeps the list non-empty,
			    so cmdk's CommandEmpty cannot carry "No matching branches." */}
			{error && (
				<p className="px-2 py-1.5 text-status-destructive text-xs" role="alert">
					{error}
				</p>
			)}
			{filtered.length === 0 && (
				<p className="px-2 py-1.5 text-muted-foreground text-sm" role="status">
					No matching branches.
				</p>
			)}
			<CommandList className="max-h-[min(60vh,520px)]">
				<CommandGroup heading="Branches">
					{visible.map((b) => {
						const isActive = b === branch;
						return (
							<CommandItem
								data-checked={isActive}
								disabled={switching !== null}
								key={b}
								onSelect={() => (isActive ? onClose() : onSwitch(b))}
								value={`branch:${b}`}
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
								{switching === b && <Spinner className="size-4 shrink-0" />}
							</CommandItem>
						);
					})}
					{hidden > 0 && (
						<CommandItem
							onSelect={() => setShowAll(true)}
							value="action:show-all-branches"
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={ArrowDown01Icon}
							/>
							<span className="flex-1 text-muted-foreground">
								Show {hidden} more branch{hidden === 1 ? "" : "es"}
							</span>
						</CommandItem>
					)}
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup>
					{/* A dirty tree blocks branch creation; otherwise the row opens the
					    dialog (which outlives this picker). */}
					<CommandItem
						aria-describedby={dirty ? dirtyReasonId : undefined}
						disabled={dirty}
						onSelect={onStartCreate}
						value="action:create-branch"
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={Add01Icon}
						/>
						<span className="flex-1">Create a new branch</span>
					</CommandItem>
					{dirty && (
						<p
							className="type-caption px-2 py-1 text-muted-foreground"
							id={dirtyReasonId}
							role="note"
						>
							Commit those changes first
						</p>
					)}
				</CommandGroup>
			</CommandList>
		</>
	);
}

/** Dialog to name and create a new git branch off HEAD, then switch to it.
 *  Controlled + rendered by WorkspacePicker so it outlives the branch picker. */
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
					aria-label="Branch name"
					// dialog opened by explicit user action; focusing the sole field is expected
					autoFocus
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
					variant="code"
				/>
				{error && <p className="text-status-destructive text-xs">{error}</p>}
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
	onClose,
	onSetMode,
	onSetBranch,
	onRegenerate,
}: {
	status: WorktreeStatus;
	worktreeMode: boolean;
	worktreeBranch: string;
	onClose: () => void;
	onSetMode: (v: boolean) => void;
	onSetBranch: (v: string) => void;
	onRegenerate: () => void;
}) {
	if (status.active) {
		// Informational only, so it sits outside a listbox that would expect
		// options.
		return (
			<div className="flex flex-col gap-2 px-2 py-2">
				<div className="flex items-center gap-2 px-1">
					<HugeiconsIcon
						className="size-4 shrink-0 text-muted-foreground"
						icon={FolderTreeIcon}
					/>
					<span
						className="min-w-0 flex-1 truncate"
						title={status.branch ?? undefined}
					>
						{status.branch}
					</span>
				</div>
				<p className="px-1 text-muted-foreground text-xs">
					{status.changed_files > 0
						? `${formatCount(status.changed_files)} changed file${status.changed_files === 1 ? "" : "s"}. Review and apply from the diff panel.`
						: "This chat runs in its own worktree. Changes are isolated until you apply them from the diff panel."}
				</p>
			</div>
		);
	}
	const selectMode = (enabled: boolean) => {
		onSetMode(enabled);
		onClose();
	};
	return (
		<CommandList>
			<CommandGroup heading="Work in">
				<ModeRow
					icon={LaptopIcon}
					onSelect={() => selectMode(false)}
					selected={!worktreeMode}
					title="Local"
				/>
				<ModeRow
					icon={FolderTreeIcon}
					onSelect={() => selectMode(true)}
					selected={worktreeMode}
					title="New worktree"
				/>
			</CommandGroup>
			{worktreeMode && (
				<div className="flex flex-col gap-1.5 px-2.5 pb-2">
					<span className="type-caption text-muted-foreground">
						Branch name
					</span>
					<div className="flex items-center gap-1.5">
						<Input
							aria-label="Branch name"
							className="flex-1"
							onChange={(e) => onSetBranch(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							placeholder="ryu/my-feature"
							purpose="picker-code-value"
							spellCheck={false}
							value={worktreeBranch}
							variant="code"
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
		</CommandList>
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
		<CommandItem
			data-checked={selected}
			onSelect={onSelect}
			value={`mode:${title}`}
		>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={icon}
			/>
			<span className="min-w-0 flex-1 truncate">{title}</span>
		</CommandItem>
	);
}

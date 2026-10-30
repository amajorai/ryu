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
	ComputerTerminal01Icon,
	Folder03Icon,
	FolderTreeIcon,
	LaptopIcon,
	PlayIcon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import { useCallback, useMemo, useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	invalidateGitStatus,
	useGitStatus,
	useWorktreeDiff,
	useWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	checkoutBranch,
	createBranch,
	fetchGitBranches,
} from "@/src/lib/api/git.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import type { ProjectEnvironment } from "@/src/store/useWorkspaceStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";
import {
	CloneFolderDialog,
	CreateFolderDialog,
	ProjectCommandDialog,
} from "./ProjectPicker.tsx";
import {
	BranchList,
	CreateBranchDialog,
} from "./WorkspacePicker-branch-list.tsx";
import {
	DiffStat,
	EnvironmentList,
	type LineStat,
	PickerCommandDialog,
	PickerRow,
	PickerTrigger,
	ReadonlyPickerRow,
	type WorkspacePickerId,
} from "./WorkspacePicker-controls.tsx";
import { useRunEnvironmentAction } from "./WorkspacePicker-environment-action.ts";
import { RunModeContent } from "./WorkspacePicker-run-mode.tsx";

export { DiffStat, type LineStat } from "./WorkspacePicker-controls.tsx";

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

const NO_STAT: LineStat = { insertions: 0, deletions: 0 };
const EMPTY_ENVIRONMENTS: ProjectEnvironment[] = [];

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
	const tl = useLiteralMessages();
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

	const runEnvironmentAction = useRunEnvironmentAction(
		closeMenus,
		folder,
		worktreeStatus.path,
		tl
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
						title={tl("Branch: {branch}", { branch })}
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
								title={
									worktreeStatus.path
										? tl("Run {name} in the worktree", { name: action.name })
										: tl("Run {name} in the project", { name: action.name })
								}
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

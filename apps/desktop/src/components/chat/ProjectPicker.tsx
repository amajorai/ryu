"use client";

import {
	Add01Icon,
	Cancel01Icon,
	Folder03Icon,
	FolderAddIcon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import {
	Command,
	CommandDialog,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
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
import { Input } from "@ryu/ui/components/input.tsx";
import { useCommandState } from "cmdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectGlyph } from "@/src/components/layout/ProjectIconDialog.tsx";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import {
	cloneProjectFolder,
	createProjectFolder,
	gitRepositoryName,
} from "@/src/lib/api/workspace.ts";
import { sameFolder } from "@/src/lib/folder-path.ts";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";

/** Fence a dialog operation to its captured node credentials and visible intent.
 * The remote mutation may finish; only its current owner may adopt the result. */
function useProjectOperationGuard(open: boolean) {
	const getActiveNode = useActiveNodeGetter();
	const epoch = useRef(0);
	const latestGetter = useRef(getActiveNode);
	if (latestGetter.current !== getActiveNode) {
		epoch.current++;
		latestGetter.current = getActiveNode;
	}
	const openRef = useRef(open);
	const disposeActive = useRef<(() => void) | null>(null);
	if (openRef.current !== open) {
		epoch.current++;
		openRef.current = open;
	}
	useEffect(
		() => () => {
			epoch.current++;
			disposeActive.current?.();
		},
		[]
	);
	useEffect(() => {
		if (!open) {
			disposeActive.current?.();
		}
	}, [open]);

	return useCallback(() => {
		disposeActive.current?.();
		const intent = ++epoch.current;
		const node = latestGetter.current();
		const identity = (value: typeof node) =>
			JSON.stringify([value.url, value.token, value.userJwt ?? null]);
		const authority = identity(node);
		let changed = false;
		let disposed = false;
		const unsubscribe = useNodeStore.subscribe(() => {
			if (identity(latestGetter.current()) !== authority) {
				changed = true;
			}
		});
		const dispose = () => {
			if (disposed) {
				return;
			}
			disposed = true;
			unsubscribe();
			if (disposeActive.current === dispose) {
				disposeActive.current = null;
			}
		};
		disposeActive.current = dispose;
		return {
			node,
			getNode: () => latestGetter.current(),
			isCurrent: () =>
				openRef.current &&
				epoch.current === intent &&
				!changed &&
				identity(latestGetter.current()) === authority,
			dispose,
		};
	}, [getActiveNode]);
}

const PATH_SEP = /[\\/]/;

export function ProjectPicker({
	onFolderSelected,
}: {
	onFolderSelected?: (folder: string) => void;
} = {}) {
	const { folder, projectNames, projects, setFolder } = useWorkspaceStore();
	const beginOperation = useProjectOperationGuard(true);
	const [pickerOpen, setPickerOpen] = useState(false);
	// The create-folder and browse dialogs live OUTSIDE the picker so they survive
	// it closing on select (a dialog nested in the picker would unmount with it).
	const [createOpen, setCreateOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [cloneOpen, setCloneOpen] = useState(false);

	const handleSelectBrowsed = useCallback(
		async (selected: string) => {
			const operation = beginOperation();
			try {
				const acknowledged = await setFolder(
					selected,
					operation.getNode,
					operation.isCurrent
				);
				if (acknowledged && operation.isCurrent()) {
					onFolderSelected?.(selected);
				}
			} catch {
				// Keep the selected project when activation fails.
			} finally {
				operation.dispose();
			}
		},
		[onFolderSelected, setFolder, beginOperation]
	);

	const activeProject = folder
		? findWorkspaceProject(projects, folder)
		: undefined;
	const folderName = activeProject
		? workspaceProjectName(activeProject, projectNames)
		: folder
			? projectNames[folder]?.trim() || folder.split(PATH_SEP).at(-1) || null
			: null;

	return (
		<>
			<Button
				appearance="composer-settings-foreground"
				aria-haspopup="dialog"
				aria-label="Select project folder"
				onClick={() => setPickerOpen(true)}
				size="sm"
				title={folder ?? "Pick a project folder"}
				type="button"
				variant="ghost"
			>
				<HugeiconsIcon className="size-3.5 shrink-0" icon={Folder03Icon} />
				<ButtonLabel className="max-w-32">
					{folderName ?? "Project"}
				</ButtonLabel>
			</Button>
			<ProjectCommandDialog
				onBrowse={() => setBrowseOpen(true)}
				onClone={() => setCloneOpen(true)}
				onFolderSelected={onFolderSelected}
				onOpenChange={setPickerOpen}
				onStartFromScratch={() => setCreateOpen(true)}
				open={pickerOpen}
			/>
			<CreateFolderDialog
				onFolderSelected={onFolderSelected}
				onOpenChange={setCreateOpen}
				open={createOpen}
			/>
			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={handleSelectBrowsed}
				open={browseOpen}
			/>
			<CloneFolderDialog
				onFolderSelected={onFolderSelected}
				onOpenChange={setCloneOpen}
				open={cloneOpen}
			/>
		</>
	);
}

interface ProjectCommandDialogProps {
	/** Opens the node-aware folder browser (owned by the persistent parent, so it
	 *  survives this picker closing). Replaces the native OS picker, which only
	 *  sees the desktop host and not a remote node. Omit to hide "New project". */
	onBrowse?: () => void;
	/** Opens the Git clone dialog owned by the persistent parent. */
	onClone?: () => void;
	onFolderSelected?: (folder: string) => void;
	onOpenChange: (open: boolean) => void;
	/** Opens the create-folder dialog (owned by the persistent parent, so it
	 *  survives this picker closing). Omit to hide "Start from scratch" (e.g. the
	 *  empty-state title offers recents only). */
	onStartFromScratch?: () => void;
	open: boolean;
}

const IS_MAC_PLATFORM =
	"navigator" in globalThis && navigator.userAgent.includes("Mac");

/** Keyboard removal of the highlighted project: forward Delete everywhere, plus
 *  Command/Meta+Backspace (Mac laptops label Backspace "delete" and need Fn for
 *  a forward Delete). */
const REMOVE_PROJECT_KEYSHORTCUTS = "Delete Meta+Backspace";
const REMOVE_PROJECT_SHORTCUT_LABEL = IS_MAC_PLATFORM
	? "Command+Delete or Fn+Delete"
	: "Delete";
const REMOVE_PROJECT_HINT = `Press ${REMOVE_PROJECT_SHORTCUT_LABEL} to remove from projects`;

function isRemoveProjectShortcut(e: React.KeyboardEvent): boolean {
	if (e.altKey || e.shiftKey || e.ctrlKey) {
		return false;
	}
	if (e.key === "Delete") {
		return !e.metaKey;
	}
	return e.key === "Backspace" && e.metaKey;
}

function isRemoveHitArea(target: EventTarget): boolean {
	return (
		target instanceof Element &&
		target.closest("[data-remove-project]") !== null
	);
}

/** The project picker as a command dialog (search + recents + create actions +
 *  clear). Every project surface — the composer, the workspace bar, the sidebar's
 *  `+`, and the empty-state title — opens this same dialog. Reads/writes the
 *  shared workspace store directly. */
export function ProjectCommandDialog({
	open,
	onOpenChange,
	...contentProps
}: ProjectCommandDialogProps) {
	return (
		<CommandDialog
			className="sm:max-w-lg"
			description="Search your projects, open one, or add a new one."
			onOpenChange={onOpenChange}
			open={open}
			title="Choose a project"
		>
			{/* Filtering stays manual so the create actions remain reachable while a
			    search narrows the project list. */}
			<Command shouldFilter={false}>
				<ProjectPickerContent
					{...contentProps}
					onClose={() => onOpenChange(false)}
				/>
			</Command>
		</CommandDialog>
	);
}

function ProjectPickerContent({
	onClose,
	onStartFromScratch,
	onBrowse,
	onClone,
	onFolderSelected,
}: Omit<ProjectCommandDialogProps, "onOpenChange" | "open"> & {
	onClose: () => void;
}) {
	const {
		folder,
		projectIcons,
		projectNames,
		projects,
		setFolder,
		removeProject,
		clearFolder,
	} = useWorkspaceStore();

	const beginOperation = useProjectOperationGuard(true);

	const [recentQuery, setRecentQuery] = useState("");
	const [selectionError, setSelectionError] = useState<string | null>(null);

	const runAction = useCallback(
		(action?: () => void) => {
			onClose();
			action?.();
		},
		[onClose]
	);

	const handleSelectRecent = useCallback(
		async (path: string) => {
			const operation = beginOperation();
			setSelectionError(null);
			try {
				const acknowledged = await setFolder(
					path,
					operation.getNode,
					operation.isCurrent
				);
				if (!(acknowledged && operation.isCurrent())) {
					return;
				}
				onFolderSelected?.(path);
				onClose();
			} catch {
				if (operation.isCurrent()) {
					setSelectionError(
						"Could not open this project. Check folder access and try again."
					);
				}
			} finally {
				operation.dispose();
			}
		},
		[onFolderSelected, setFolder, onClose, beginOperation]
	);

	// Removing here uses removeProject (not just removeRecentFolder) so the folder
	// also disappears from the sidebar's Projects section and stays gone even if it
	// still has conversations — both surfaces read the same store.
	// The remove glyph is a non-focusable, aria-hidden hit area inside the option
	// (never a nested control), so its click is intercepted on the option itself
	// before cmdk turns it into a selection.
	const handleRemoveClickCapture = useCallback(
		(e: React.MouseEvent<HTMLDivElement>, projectId: string) => {
			if (!isRemoveHitArea(e.target)) {
				return;
			}
			e.stopPropagation();
			e.preventDefault();
			removeProject(projectId);
		},
		[removeProject]
	);

	// cmdk keeps focus in the search box, so the hover-only remove glyph is not
	// reachable from the keyboard. The highlighted row is removed by Delete (with
	// the caret at the end of the search, where it would otherwise do nothing) or
	// by Command/Meta+Backspace — the Finder "Move to Trash" chord — because Mac
	// laptop keyboards have no forward Delete key without Fn.
	const highlightedValue = useCommandState((state) => state.value);
	const handleSearchKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (!isRemoveProjectShortcut(e)) {
				return;
			}
			if (e.key === "Delete") {
				const input = e.currentTarget;
				const caretAtEnd =
					input.selectionStart === input.value.length &&
					input.selectionEnd === input.value.length;
				if (!caretAtEnd) {
					return;
				}
			}
			const highlighted = projects.find(
				(project) =>
					`project:${project.id}`.toLowerCase() ===
					highlightedValue?.toLowerCase()
			);
			if (!highlighted) {
				return;
			}
			e.preventDefault();
			removeProject(highlighted.id);
		},
		[highlightedValue, projects, removeProject]
	);

	const hasProjects = projects.length > 0;
	const hasActions = Boolean(onBrowse || onClone || onStartFromScratch);
	const rq = recentQuery.trim().toLowerCase();
	const filteredProjects = rq
		? projects.filter((project) => {
				const name = workspaceProjectName(project, projectNames).toLowerCase();
				return (
					name.includes(rq) ||
					project.folders.some((path) => path.toLowerCase().includes(rq))
				);
			})
		: projects;

	return (
		<>
			{hasProjects && (
				<CommandInput
					onKeyDown={handleSearchKeyDown}
					onValueChange={setRecentQuery}
					placeholder="Search projects"
					spellCheck={false}
					value={recentQuery}
				/>
			)}
			{/* Status text stays outside the listbox, which may only own options and
			    groups. The action rows can keep the list non-empty, so cmdk's
			    CommandEmpty cannot carry this message. */}
			{hasProjects && filteredProjects.length === 0 && (
				<p className="px-2 py-1.5 text-muted-foreground text-sm" role="status">
					No matching projects.
				</p>
			)}
			{selectionError && (
				<p className="px-2 py-1.5 text-status-destructive text-xs" role="alert">
					{selectionError}
				</p>
			)}
			<CommandList className="max-h-[min(60vh,520px)]">
				{filteredProjects.length > 0 && (
					<CommandGroup heading="Projects">
						{filteredProjects.map((project) => {
							const name = workspaceProjectName(project, projectNames);
							const primary = project.folders[0];
							const isActive = project.folders.some(
								(path) => folder !== null && sameFolder(path, folder)
							);
							return (
								<CommandItem
									aria-description={REMOVE_PROJECT_HINT}
									aria-keyshortcuts={REMOVE_PROJECT_KEYSHORTCUTS}
									aria-label={`Open ${name}`}
									className="group/recent"
									data-checked={isActive}
									disabled={!primary}
									key={project.id}
									onClickCapture={(e) =>
										handleRemoveClickCapture(e, project.id)
									}
									onMouseDownCapture={(e) => {
										// Keep focus in the search box when the glyph is pressed.
										if (isRemoveHitArea(e.target)) {
											e.preventDefault();
										}
									}}
									onSelect={() => {
										if (primary) {
											void handleSelectRecent(primary);
										}
									}}
									value={`project:${project.id}`}
								>
									<span className="shrink-0 text-foreground/40">
										<ProjectGlyph
											fallback={
												<HugeiconsIcon className="size-4" icon={Folder03Icon} />
											}
											icon={primary ? projectIcons[primary] : undefined}
											size={16}
										/>
									</span>
									<div className="min-w-0 flex-1">
										<div
											className="truncate font-medium text-foreground/80"
											title={name}
										>
											{name}
										</div>
										{project.folders.map((source) => (
											<div
												className="type-compact truncate font-mono font-normal text-muted-foreground"
												key={source}
												title={source}
											>
												{source}
											</div>
										))}
									</div>
									{/* Remove sits beside the active tick and only shows on hover
										    or keyboard highlight, so it never competes with the row.
										    It is a pointer-only hit area, not a nested control: the
										    option is the row's single interactive element, its click is
										    handled by the option's capture handler, and the keyboard
										    uses the shortcut announced in aria-keyshortcuts. */}
									<span
										aria-hidden="true"
										className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-opacity duration-150 hover:bg-foreground/10 group-hover/recent:opacity-100 group-data-selected/recent:opacity-100"
										data-remove-project=""
										title={`Remove from projects (${REMOVE_PROJECT_SHORTCUT_LABEL})`}
									>
										<HugeiconsIcon
											className="size-4 text-foreground/50"
											icon={Cancel01Icon}
										/>
									</span>
								</CommandItem>
							);
						})}
					</CommandGroup>
				)}

				{filteredProjects.length > 0 && (hasActions || folder) && (
					<CommandSeparator />
				)}

				{/* Project creation stays flat: every action is one keystroke or click
				    away, with no flyout nested inside the project picker. */}
				{(hasActions || folder) && (
					<CommandGroup>
						{onBrowse && (
							<CommandItem
								onSelect={() => runAction(onBrowse)}
								value="action:new-project"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-foreground/40"
									icon={FolderAddIcon}
								/>
								New project
							</CommandItem>
						)}
						{onClone && (
							<CommandItem
								onSelect={() => runAction(onClone)}
								value="action:clone"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-foreground/40"
									icon={SourceCodeIcon}
								/>
								Clone from Git
							</CommandItem>
						)}
						{onStartFromScratch && (
							<CommandItem
								onSelect={() => runAction(onStartFromScratch)}
								value="action:start-from-scratch"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-foreground/40"
									icon={Add01Icon}
								/>
								Start from scratch
							</CommandItem>
						)}
						{folder && (
							<CommandItem
								className="text-foreground/70"
								onSelect={() => runAction(clearFolder)}
								value="action:clear-project"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-foreground/40"
									icon={Cancel01Icon}
								/>
								Do not work in a project
							</CommandItem>
						)}
					</CommandGroup>
				)}
			</CommandList>
		</>
	);
}

/** Dialog to name and create a fresh project folder under Documents/Ryu, then open
 *  it. Controlled + rendered by the persistent picker parent (ProjectPicker /
 *  WorkspacePicker) so it outlives the project dialog that launches it. */
export function CreateFolderDialog({
	open: dialogOpen,
	onOpenChange,
	onFolderSelected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onFolderSelected?: (folder: string) => void;
}) {
	const { setFolder } = useWorkspaceStore();
	const activeNode = useActiveNode();
	const beginOperation = useProjectOperationGuard(dialogOpen);
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createdPath, setCreatedPath] = useState<string | null>(null);

	useEffect(() => {
		if (dialogOpen) {
			setCreating(false);
			setName("");
			setCreatedPath(null);
			setError(null);
		}
	}, [dialogOpen]);

	useEffect(() => {
		setCreatedPath(null);
		setCreating(false);
		setError(null);
	}, [activeNode.url, activeNode.token, activeNode.userJwt]);

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!(trimmed || createdPath) || creating) {
			return;
		}
		const operation = beginOperation();
		setCreating(true);
		setError(null);
		try {
			let created = createdPath;
			if (!created) {
				const result = await createProjectFolder(
					{
						url: operation.node.url,
						token: operation.node.token,
						userJwt: operation.node.userJwt ?? null,
					},
					trimmed
				);
				if (!operation.isCurrent()) {
					return;
				}
				if (!result.path) {
					setError(result.error ?? "Could not create the folder");
					return;
				}
				created = result.path;
				setCreatedPath(created);
			}

			try {
				if (
					!(
						(await setFolder(
							created,
							operation.getNode,
							operation.isCurrent
						)) && operation.isCurrent()
					)
				) {
					return;
				}
			} catch {
				if (!operation.isCurrent()) {
					return;
				}
				setError(
					"Created the folder, but could not open it. Try again to retry."
				);
				return;
			}

			if (!operation.isCurrent()) {
				return;
			}
			onFolderSelected?.(created);
			setName("");
			setCreatedPath(null);
			onOpenChange(false);
		} finally {
			operation.dispose();
			if (operation.isCurrent()) {
				setCreating(false);
			}
		}
	}, [
		name,
		creating,
		createdPath,
		activeNode.url,
		activeNode.token,
		activeNode.userJwt,
		beginOperation,
		setFolder,
		onOpenChange,
		onFolderSelected,
	]);

	return (
		<Dialog onOpenChange={onOpenChange} open={dialogOpen}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Start from scratch</DialogTitle>
					<DialogDescription>
						Create a new project folder in Documents/Ryu.
					</DialogDescription>
				</DialogHeader>
				<Input
					aria-label="Project name"
					// dialog opened by explicit user action; focusing the sole field is expected
					autoFocus
					disabled={creating || Boolean(createdPath)}
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
					placeholder="New project name"
					spellCheck={false}
					value={name}
				/>
				{error && (
					<p className="text-status-destructive text-xs" role="alert">
						{error}
					</p>
				)}
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button
						disabled={!createdPath && name.trim().length === 0}
						loading={creating}
						onClick={handleCreate}
						type="button"
					>
						{createdPath ? "Try opening project" : "Create project"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Dialog to clone a Git repository onto the active node, then open the
 * resulting checkout as the active project. The active node owns both the
 * destination filesystem and the SSH configuration used by a Git clone. */
export function CloneFolderDialog({
	activate = true,
	onFolderSelected,
	onOpenChange,
	open: dialogOpen,
}: {
	activate?: boolean;
	onFolderSelected?: (folder: string) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const { setFolder } = useWorkspaceStore();
	const activeNode = useActiveNode();
	const beginOperation = useProjectOperationGuard(dialogOpen);
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	const [cloning, setCloning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [clonedPath, setClonedPath] = useState<string | null>(null);

	useEffect(() => {
		if (dialogOpen) {
			setCloning(false);
			setUrl("");
			setName("");
			setNameTouched(false);
			setClonedPath(null);
			setError(null);
		}
	}, [dialogOpen]);

	useEffect(() => {
		setClonedPath(null);
		setCloning(false);
		setError(null);
	}, [activeNode.url, activeNode.token, activeNode.userJwt]);

	const handleClone = useCallback(async () => {
		const trimmedUrl = url.trim();
		if (!(trimmedUrl || clonedPath) || cloning) {
			return;
		}
		const operation = beginOperation();
		setCloning(true);
		setError(null);
		try {
			let cloned = clonedPath;
			if (!cloned) {
				const result = await cloneProjectFolder(
					{
						url: operation.node.url,
						token: operation.node.token,
						userJwt: operation.node.userJwt ?? null,
					},
					trimmedUrl,
					name
				);
				if (!operation.isCurrent()) {
					return;
				}
				if (!result.path) {
					setError(result.error ?? "Could not clone the repository");
					return;
				}
				cloned = result.path;
				setClonedPath(cloned);
			}
			if (activate) {
				try {
					if (
						!(
							(await setFolder(
								cloned,
								operation.getNode,
								operation.isCurrent
							)) && operation.isCurrent()
						)
					) {
						return;
					}
				} catch {
					if (!operation.isCurrent()) {
						return;
					}
					setError(
						"Cloned the repository, but could not open it. Try again to retry."
					);
					return;
				}
			}
			if (!operation.isCurrent()) {
				return;
			}
			onFolderSelected?.(cloned);
			setUrl("");
			setName("");
			setNameTouched(false);
			setClonedPath(null);
			onOpenChange(false);
		} finally {
			operation.dispose();
			if (operation.isCurrent()) {
				setCloning(false);
			}
		}
	}, [
		activeNode.token,
		activeNode.userJwt,
		beginOperation,
		activeNode.url,
		activate,
		clonedPath,
		cloning,
		name,
		onFolderSelected,
		onOpenChange,
		setFolder,
		url,
	]);

	const locationLabel =
		activeNode.name === "local"
			? "this device"
			: `the "${activeNode.name}" node`;

	return (
		<Dialog onOpenChange={onOpenChange} open={dialogOpen}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Clone Git repository</DialogTitle>
					<DialogDescription>
						Clone a GitHub, GitLab, Azure DevOps, or other Git repository onto{" "}
						{locationLabel}. HTTPS uses Git credentials configured on that node;
						SSH uses its configured keys. Don't put access tokens in the URL.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<label className="font-medium text-sm" htmlFor="git-clone-url">
							Repository URL
						</label>
						<Input
							aria-label="Repository URL"
							autoCapitalize="off"
							autoCorrect="off"
							disabled={cloning || Boolean(clonedPath)}
							id="git-clone-url"
							onChange={(event) => {
								const value = event.target.value;
								setUrl(value);
								if (!nameTouched) {
									setName(gitRepositoryName(value) ?? "");
								}
								setError(null);
							}}
							placeholder="https://gitlab.com/group/project.git"
							spellCheck={false}
							value={url}
							variant="code-caption"
						/>
						<p className="type-caption text-muted-foreground">
							Use an HTTPS or SSH clone URL. Private repositories use the Git
							credentials or SSH keys configured on this node.
						</p>
					</div>
					<div className="space-y-1.5">
						<label className="font-medium text-sm" htmlFor="git-clone-name">
							Folder name
						</label>
						<Input
							aria-label="Folder name"
							disabled={cloning || Boolean(clonedPath)}
							id="git-clone-name"
							onChange={(event) => {
								setNameTouched(true);
								setName(event.target.value);
								setError(null);
							}}
							placeholder="repo"
							value={name}
						/>
					</div>
					{error && (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					)}
				</div>
				<DialogFooter>
					<DialogClose render={<Button disabled={cloning} variant="ghost" />}>
						Cancel
					</DialogClose>
					<Button
						disabled={!(url.trim() || clonedPath)}
						loading={cloning}
						onClick={handleClone}
						type="button"
					>
						{clonedPath ? "Try opening project" : "Clone repository"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

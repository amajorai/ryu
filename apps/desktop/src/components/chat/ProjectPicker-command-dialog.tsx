"use client";

import {
	Add01Icon,
	Cancel01Icon,
	Folder03Icon,
	FolderAddIcon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Command,
	CommandDialog,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import { useCommandState } from "cmdk";
import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ProjectGlyph } from "@/src/components/layout/ProjectIconDialog.tsx";
import { sameFolder } from "@/src/lib/folder-path.ts";
import { workspaceProjectName } from "@/src/lib/workspace-projects.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { useProjectOperationGuard } from "./ProjectPicker-operation-guard.ts";

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
	} = useWorkspaceStore(
		useShallow((s) => ({
			folder: s.folder,
			projectIcons: s.projectIcons,
			projectNames: s.projectNames,
			projects: s.projects,
			setFolder: s.setFolder,
			removeProject: s.removeProject,
			clearFolder: s.clearFolder,
		}))
	);

	const beginOperation = useProjectOperationGuard(true);
	const tl = useLiteralMessages();

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
									aria-description={tl(
										"Press {shortcut} to remove from projects",
										{ shortcut: REMOVE_PROJECT_SHORTCUT_LABEL }
									)}
									aria-keyshortcuts={REMOVE_PROJECT_KEYSHORTCUTS}
									aria-label={tl("Open {name}", { name })}
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
										title={tl("Remove from projects ({shortcut})", {
											shortcut: REMOVE_PROJECT_SHORTCUT_LABEL,
										})}
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

"use client";

import {
	Add01Icon,
	Cancel01Icon,
	Folder03Icon,
	FolderAddIcon,
	FolderOpenIcon,
	Search01Icon,
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
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useState } from "react";
import {
	WORKSPACE_SELECT_ITEM,
	WORKSPACE_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";
import { ProjectGlyph } from "@/src/components/layout/ProjectIconDialog.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { createProjectFolder } from "@/src/lib/api/workspace.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";

const PATH_SEP = /[\\/]/;

export function ProjectPicker() {
	const { folder, setFolder } = useWorkspaceStore();
	const [menuOpen, setMenuOpen] = useState(false);
	// The create-folder and browse dialogs live OUTSIDE the menu so they survive
	// the menu closing on select (a dialog nested in the menu would unmount with it).
	const [createOpen, setCreateOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);

	const handleSelectBrowsed = useCallback(
		(selected: string) => {
			// Browsed paths come from Core's own listing, so activation should
			// succeed; on a transient failure keep the current folder rather than
			// clearing it out from under the user.
			setFolder(selected).catch(() => {
				// no-op
			});
		},
		[setFolder]
	);

	const folderName = folder ? folder.split(PATH_SEP).at(-1) : null;

	return (
		<>
			<DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label="Select project folder"
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
				</DropdownMenuTrigger>

				<DropdownMenuContent
					align="start"
					className="max-h-[60vh] w-64 overflow-y-auto"
					side="top"
					sideOffset={6}
				>
					<ProjectPickerContent
						onBrowse={() => {
							setMenuOpen(false);
							setBrowseOpen(true);
						}}
						onClose={() => setMenuOpen(false)}
						onStartFromScratch={() => {
							setMenuOpen(false);
							setCreateOpen(true);
						}}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
			<CreateFolderDialog onOpenChange={setCreateOpen} open={createOpen} />
			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={handleSelectBrowsed}
				open={browseOpen}
			/>
		</>
	);
}

/** The folder-selector body (recents + browse + clear), reusable under any menu
 *  trigger (the standalone picker and WorkspacePicker's Folder submenu both mount
 *  it inside a dropdown-menu). Reads/writes the shared workspace store directly. */
export function ProjectPickerContent({
	onClose,
	onStartFromScratch,
	onBrowse,
}: {
	onClose: () => void;
	/** Opens the create-folder dialog (owned by the persistent parent, so it
	 *  survives this menu closing). Omit to hide the "New project" submenu (e.g.
	 *  the empty-state popover offers recents only). */
	onStartFromScratch?: () => void;
	/** Opens the node-aware folder browser (owned by the persistent parent, so it
	 *  survives this menu closing). Replaces the native OS picker, which only sees
	 *  the desktop host and not a remote node. Omit to hide the "New project"
	 *  submenu. */
	onBrowse?: () => void;
}) {
	const {
		folder,
		recentFolders,
		projectIcons,
		setFolder,
		removeProject,
		clearFolder,
	} = useWorkspaceStore();

	const [recentQuery, setRecentQuery] = useState("");

	const handleBrowse = useCallback(() => {
		onClose();
		onBrowse?.();
	}, [onBrowse, onClose]);

	const handleSelectRecent = useCallback(
		async (path: string) => {
			onClose();
			// Selecting must never REMOVE the folder: removal is the X button's job
			// only. If activation fails (e.g. the folder is gone), leave the row be.
			await setFolder(path).catch(() => {
				// no-op: keep the recent; the user removes it explicitly via the X.
			});
		},
		[setFolder, onClose]
	);

	// Removing here uses removeProject (not just removeRecentFolder) so the folder
	// also disappears from the sidebar's Projects section and stays gone even if it
	// still has conversations — both surfaces read the same store.
	const handleRemoveRecent = useCallback(
		(e: React.MouseEvent, path: string) => {
			e.stopPropagation();
			removeProject(path);
		},
		[removeProject]
	);

	const hasRecents = recentFolders.length > 0;
	const rq = recentQuery.trim().toLowerCase();
	const filteredRecents = rq
		? recentFolders.filter((p) => p.toLowerCase().includes(rq))
		: recentFolders;

	return (
		<>
			{hasRecents && (
				<>
					<div className="sticky top-0 z-10 mb-1 bg-muted/95 pb-1 backdrop-blur-2xl">
						<div className="relative">
							<HugeiconsIcon
								className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								className="h-7 border-transparent bg-transparent pl-7 text-[12px]"
								onChange={(e) => setRecentQuery(e.target.value)}
								onKeyDown={(e) => e.stopPropagation()}
								placeholder="Search recent folders"
								spellCheck={false}
								value={recentQuery}
							/>
						</div>
					</div>
					{filteredRecents.length === 0 ? (
						<p className="px-2 py-1.5 text-muted-foreground text-sm">
							No matching folders.
						</p>
					) : (
						filteredRecents.map((path) => {
							const name = path.split(PATH_SEP).at(-1) ?? path;
							const isActive = path === folder;
							return (
								<div
									className={cn(
										"group/recent relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/10",
										isActive && "bg-foreground/10"
									)}
									key={path}
								>
									{/* Full-row overlay: clicking the row opens/sets this folder. */}
									<button
										aria-label={`Open ${name}`}
										className="absolute inset-0 cursor-pointer rounded-lg"
										onClick={() => handleSelectRecent(path)}
										type="button"
									/>

									<span className="pointer-events-none relative shrink-0 text-foreground/40">
										<ProjectGlyph
											fallback={
												<HugeiconsIcon className="size-4" icon={Folder03Icon} />
											}
											icon={projectIcons[path]}
											size={16}
										/>
									</span>

									<span className="pointer-events-none relative min-w-0 flex-1 truncate font-medium text-foreground/80">
										{name}
									</span>

									{/* Right slot: active dot at rest, remove X on hover. */}
									<div className="relative z-10 size-4 shrink-0">
										{isActive && (
											<span className="pointer-events-none absolute inset-0 m-auto size-1.5 rounded-full bg-foreground/40 transition-opacity duration-150 group-hover/recent:opacity-0" />
										)}
										<button
											aria-label={`Remove ${name} from recents`}
											className="pointer-events-none absolute inset-0 flex cursor-pointer items-center justify-center opacity-0 transition-opacity duration-150 group-hover/recent:pointer-events-auto group-hover/recent:opacity-100"
											onClick={(e) => handleRemoveRecent(e, path)}
											type="button"
										>
											<HugeiconsIcon
												className="size-4 text-foreground/50"
												icon={Cancel01Icon}
											/>
										</button>
									</div>
								</div>
							);
						})
					)}

					<div className="mx-2 my-1 border-border border-t" />
				</>
			)}

			{/* Browse ▸ { Open existing folder · Start from scratch }. Hidden when the
			    host offers neither action (e.g. the empty-state popover). */}
			{(onBrowse || onStartFromScratch) && (
			<DropdownMenuSub>
				<DropdownMenuSubTrigger>
					<HugeiconsIcon
						className="size-4 shrink-0 text-foreground/40"
						icon={FolderAddIcon}
					/>
					<span className="text-foreground/70">New project</span>
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="w-64">
					{onBrowse && (
						<DropdownMenuItem onClick={handleBrowse}>
							<HugeiconsIcon
								className="size-4 shrink-0 text-foreground/40"
								icon={FolderOpenIcon}
							/>
							Open existing folder
						</DropdownMenuItem>
					)}

					{/* Start from scratch: opens a dialog to name a new folder created
					    under Documents/Ryu (the dialog is owned by the parent so it
					    survives this menu closing). */}
					{onStartFromScratch && (
					<DropdownMenuItem onClick={onStartFromScratch}>
						<HugeiconsIcon
							className="size-4 shrink-0 text-foreground/40"
							icon={Add01Icon}
						/>
						Start from scratch
					</DropdownMenuItem>
					)}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			)}

			{folder && (
				<button
					className={cn(
						WORKSPACE_SELECT_ITEM,
						"flex cursor-pointer text-foreground/70 transition-colors hover:bg-foreground/10"
					)}
					onClick={() => {
						onClose();
						clearFolder();
					}}
					type="button"
				>
					<HugeiconsIcon
						className="size-4 shrink-0 text-foreground/40"
						icon={Cancel01Icon}
					/>
					Do not work in a project
				</button>
			)}
		</>
	);
}

/** Dialog to name and create a fresh project folder under Documents/Ryu, then open
 *  it. Controlled + rendered by the persistent picker parent (ProjectPicker /
 *  WorkspacePicker) so it outlives the dropdown menu that launches it. */
export function CreateFolderDialog({
	open: dialogOpen,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { setFolder } = useWorkspaceStore();
	const activeNode = useActiveNode();
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!trimmed || creating) {
			return;
		}
		setCreating(true);
		setError(null);
		const result = await createProjectFolder(
			{ url: activeNode.url, token: activeNode.token ?? null },
			trimmed
		);
		setCreating(false);
		if (result.path) {
			const created = result.path;
			setName("");
			onOpenChange(false);
			await setFolder(created).catch(() =>
				setError("Created the folder, but could not open it")
			);
		} else {
			setError(result.error ?? "Could not create the folder");
		}
	}, [
		name,
		creating,
		activeNode.url,
		activeNode.token,
		setFolder,
		onOpenChange,
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
					// biome-ignore lint/a11y/noAutofocus: dialog opened by explicit user action; focusing the sole field is expected
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
					placeholder="New project name"
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
						{creating ? <Spinner className="size-4" /> : "Create project"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

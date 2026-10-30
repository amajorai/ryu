"use client";

import { Folder03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button, ButtonLabel } from "@ryu/ui/components/button.tsx";
import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	findWorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { NodeFolderBrowser } from "./NodeFolderBrowser.tsx";
import { CloneFolderDialog } from "./ProjectPicker-clone-folder-dialog.tsx";
import { ProjectCommandDialog } from "./ProjectPicker-command-dialog.tsx";
import { CreateFolderDialog } from "./ProjectPicker-create-folder-dialog.tsx";
import { useProjectOperationGuard } from "./ProjectPicker-operation-guard.ts";

export { CloneFolderDialog } from "./ProjectPicker-clone-folder-dialog.tsx";
export { ProjectCommandDialog } from "./ProjectPicker-command-dialog.tsx";
export { CreateFolderDialog } from "./ProjectPicker-create-folder-dialog.tsx";

const PATH_SEP = /[\\/]/;

export function ProjectPicker({
	onFolderSelected,
}: {
	onFolderSelected?: (folder: string) => void;
} = {}) {
	const { folder, projectNames, projects, setFolder } = useWorkspaceStore(
		useShallow((s) => ({
			folder: s.folder,
			projectNames: s.projectNames,
			projects: s.projects,
			setFolder: s.setFolder,
		}))
	);
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

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectSettingsDialog } from "../../src/components/layout/ProjectSettingsDialog.tsx";
import {
	projectIdForFolder,
	type WorkspaceProject,
} from "../../src/lib/workspace-projects.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import "../../src/index.css";

const PRIMARY_FOLDER = "/Users/jiawei/Documents/DescomicWeb";
const SECONDARY_FOLDER = "/Users/jiawei/Documents/DescomicApi";

const PROJECT: WorkspaceProject = {
	folders: [PRIMARY_FOLDER, SECONDARY_FOLDER],
	id: projectIdForFolder(PRIMARY_FOLDER),
	name: "Descomic",
};

useWorkspaceStore.setState({
	activeProjectEnvironments: {},
	folder: PRIMARY_FOLDER,
	projectEnvironments: {},
	projectNames: {},
	projects: [PROJECT],
});

function Story() {
	const [open, setOpen] = useState(true);
	const activeFolder = useWorkspaceStore((state) => state.folder);

	return (
		<div className="dark min-h-screen bg-background p-10 text-foreground">
			<span
				aria-hidden="true"
				className="hidden"
				data-active-folder={activeFolder ?? ""}
			/>
			<div className="mx-auto max-w-3xl">
				<button
					className="mb-4 rounded-lg bg-secondary px-3 py-2 text-sm"
					onClick={() => setOpen(true)}
					type="button"
				>
					Edit project
				</button>
				<p className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
					Project settings browser proof
				</p>
				<p className="text-muted-foreground text-sm">
					The dialog below is the real desktop project settings surface.
				</p>
			</div>
			<ProjectSettingsDialog
				onOpenChange={setOpen}
				open={open}
				path={PRIMARY_FOLDER}
			/>
		</div>
	);
}

document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")!).render(<Story />);

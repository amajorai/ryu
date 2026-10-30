import { FileTreePanel } from "@/src/components/panels/workspace-panels/file-tree-panel.tsx";

export default function ProjectFilesPage({ folder }: { folder: string }) {
	return (
		<div className="h-full min-h-0">
			<FileTreePanel folder={folder} />
		</div>
	);
}

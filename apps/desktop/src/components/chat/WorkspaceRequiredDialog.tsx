import { Folder03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { ProjectPicker } from "@/src/components/chat/ProjectPicker.tsx";

export function WorkspaceRequiredDialog({
	onFolderSelected,
	onOpenChange,
	open,
}: {
	onFolderSelected: (folder: string) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				appearance="workspace-required"
				data-testid="workspace-required-dialog"
			>
				<DialogHeader>
					<DialogTitle>Choose a project to edit</DialogTitle>
					<DialogDescription>
						This request mentions local files or code. Pick a project once and
						Ryu will send it there; ordinary questions do not need a folder.
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-3 rounded-2xl border border-border bg-muted/30 p-3">
					<HugeiconsIcon
						aria-hidden
						className="size-5 shrink-0 text-muted-foreground"
						icon={Folder03Icon}
					/>
					<div className="min-w-0 flex-1">
						<p className="font-medium text-sm">Project folder</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							Your chat will remember this project.
						</p>
					</div>
					<ProjectPicker onFolderSelected={onFolderSelected} />
				</div>
			</DialogContent>
		</Dialog>
	);
}

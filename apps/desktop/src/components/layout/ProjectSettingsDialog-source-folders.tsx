import {
	Cancel01Icon,
	Folder03Icon,
	FolderAddIcon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type { Dispatch, SetStateAction } from "react";
import { sameFolder } from "@/src/lib/folder-path.ts";
import { promoteProjectFolder } from "@/src/lib/workspace-projects.ts";

export function ProjectSourceFoldersSection({
	saving,
	setBrowseOpen,
	setCloneOpen,
	setSourceFolders,
	sourceFolders,
}: {
	saving: boolean;
	setBrowseOpen: (open: boolean) => void;
	setCloneOpen: (open: boolean) => void;
	setSourceFolders: Dispatch<SetStateAction<string[]>>;
	sourceFolders: string[];
}) {
	const tl = useLiteralMessages();
	return (
		<section className="flex flex-col gap-1.5">
			<Label>Source folders</Label>
			<p className="text-muted-foreground text-xs">
				Add folders agents can read and edit. The first folder is the primary
				project workspace.
			</p>
			<div className="overflow-hidden rounded-lg border">
				{sourceFolders.length === 0 ? (
					<button
						className="flex w-full flex-col items-center justify-center gap-2 px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-muted/40"
						onClick={() => setBrowseOpen(true)}
						type="button"
					>
						<HugeiconsIcon className="size-5" icon={FolderAddIcon} />
						<span className="text-sm">
							Add folders agents can read and edit
						</span>
					</button>
				) : (
					sourceFolders.map((folder, index) => (
						<div
							className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
							data-project-source-folder={folder}
							key={folder}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={Folder03Icon}
							/>
							<span
								className="min-w-0 flex-1 truncate font-mono text-xs"
								title={folder}
							>
								{folder}
							</span>
							{index === 0 && (
								<span className="rounded-md border px-2 py-1 text-muted-foreground text-xs">
									Primary
								</span>
							)}
							{index > 0 && (
								<Button
									appearance="plain-label"
									aria-label={tl("Make {folder} primary", { folder })}
									disabled={saving}
									onClick={() =>
										setSourceFolders((current) =>
											promoteProjectFolder(current, folder)
										)
									}
									size="sm"
									type="button"
									variant="secondary"
								>
									Make primary
								</Button>
							)}
							<Button
								aria-label={tl("Remove {folder}", { folder })}
								disabled={saving}
								onClick={() =>
									setSourceFolders((current) =>
										current.filter((item) => !sameFolder(item, folder))
									)
								}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							</Button>
						</div>
					))
				)}
				<div className="flex border-t">
					<button
						className="flex flex-1 items-center gap-3 px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-muted/40 hover:text-foreground"
						onClick={() => setBrowseOpen(true)}
						type="button"
					>
						<HugeiconsIcon className="size-4" icon={FolderAddIcon} />
						Add folder
					</button>
					<button
						className="flex flex-1 items-center gap-3 border-l px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-muted/40 hover:text-foreground"
						onClick={() => setCloneOpen(true)}
						type="button"
					>
						<HugeiconsIcon className="size-4" icon={SourceCodeIcon} />
						Clone from Git
					</button>
				</div>
			</div>
		</section>
	);
}

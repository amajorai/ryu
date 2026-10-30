import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";
import { TYPE_META } from "./library-sections.ts";
import type { LibraryItemActions } from "./use-library-item-actions.ts";

/** The Library's one rename dialog and one delete confirmation, shared by every
 *  card's right-click menu. */
export function LibraryItemDialogs({
	actions,
}: {
	actions: LibraryItemActions;
}) {
	const tl = useLiteralMessages();
	const {
		busy,
		commitDelete,
		commitRename,
		deleteError,
		deleting,
		renameDraft,
		renameError,
		renaming,
		setDeleteError,
		setDeleting,
		setRenameDraft,
		setRenameError,
		setRenaming,
	} = actions;
	return (
		<>
			{/* One rename dialog for the whole page — the card menu only names which
			    item it is for. Submitting on Enter matches the sidebar's inline
			    rename, which is the gesture this replaces on this surface. */}
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setRenaming(null);
						setRenameError(null);
					}
				}}
				open={renaming !== null}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle
							className="max-w-[calc(100%-2rem)]"
							typography="wrapped-label"
						>
							{tl("Rename {name}", { name: renaming?.name ?? "" })}
						</DialogTitle>
					</DialogHeader>
					<Input
						aria-label="New name"
						autoFocus
						onChange={(e) => {
							setRenameDraft(e.target.value);
							setRenameError(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void commitRename();
							}
						}}
						placeholder="Name"
						value={renameDraft}
					/>
					{renameError ? (
						<p
							aria-live="polite"
							className="text-sm text-status-destructive"
							role="alert"
						>
							{renameError}
						</p>
					) : null}
					<DialogFooter>
						<Button
							onClick={() => {
								setRenameError(null);
								setRenaming(null);
							}}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							disabled={busy || renameDraft.trim().length === 0}
							onClick={() => {
								void commitRename();
							}}
							type="button"
						>
							Rename
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<DestructiveConfirmDialog
				busy={busy}
				description={tl(
					'"{name}" will be permanently deleted. This cannot be undone.',
					{ name: deleting?.name ?? "" }
				)}
				error={deleteError}
				impact={
					deleting?.type === "agent" ? (
						<p className="text-muted-foreground">
							Channels and their shared Core session history stay in place. If a
							channel receives a new message, it uses the default agent and
							shows a binding warning. Scheduled jobs for this agent are
							removed.
						</p>
					) : deleting?.type === "space" ? (
						<p className="text-muted-foreground">
							The Space and its documents are permanently deleted.
						</p>
					) : deleting?.type === "channel" ? (
						<p className="text-muted-foreground">
							The bot credentials and channel configuration are deleted; its
							Core session history is kept.
						</p>
					) : null
				}
				label={
					deleting
						? tl("Delete {name}", { name: deleting.name })
						: tl("Delete this item")
				}
				onConfirm={commitDelete}
				onOpenChange={(open) => {
					if (!(open || busy)) {
						setDeleting(null);
						setDeleteError(null);
					}
				}}
				open={deleting !== null}
				title={
					deleting
						? tl("Delete {type}?", {
								type: TYPE_META[deleting.type].label.toLowerCase(),
							})
						: tl("Delete item?")
				}
			/>
		</>
	);
}

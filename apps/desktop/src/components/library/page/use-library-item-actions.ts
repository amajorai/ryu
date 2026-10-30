import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useRef, useState } from "react";
import type { LibraryItem } from "./library-sections.ts";

/** Rename and delete state for the card menu's one shared dialog pair. */
export function useLibraryItemActions() {
	const tl = useLiteralMessages();
	// `tl` is a new function every render; read it through a ref so the commit
	// callbacks below keep their identity between renders.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// Rename and delete are reached from a card's right-click menu. The dialogs
	// live ONCE here rather than per card: the grid renders every item in the
	// collection, and mounting a dialog pair inside each card would put hundreds of
	// closed dialogs in the tree to serve the one the user actually opens.
	const [renaming, setRenaming] = useState<LibraryItem | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [renameError, setRenameError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<LibraryItem | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const beginRename = useCallback((item: LibraryItem) => {
		setRenameDraft(item.name);
		setRenameError(null);
		setRenaming(item);
	}, []);

	const commitRename = useCallback(async () => {
		const item = renaming;
		const title = renameDraft.trim();
		if (!(item?.rename && title) || title === item.name) {
			setRenameError(null);
			setRenaming(null);
			return;
		}
		setBusy(true);
		setRenameError(null);
		try {
			const saved = await item.rename(title);
			if (saved === false) {
				setRenameError(
					tlRef.current("Couldn't rename {name}", { name: item.name })
				);
				return;
			}
			setRenaming(null);
		} catch {
			setRenameError(
				tlRef.current("Couldn't rename {name}", { name: item.name })
			);
		} finally {
			setBusy(false);
		}
	}, [renaming, renameDraft]);

	const commitDelete = useCallback(async (): Promise<boolean> => {
		const item = deleting;
		if (!item?.remove) {
			setDeleting(null);
			setDeleteError(null);
			return true;
		}
		setBusy(true);
		setDeleteError(null);
		try {
			const removed = await item.remove();
			if (removed === false) {
				setDeleteError(
					tlRef.current("Couldn't delete {name}", { name: item.name })
				);
				return false;
			}
			setDeleting(null);
			setDeleteError(null);
			return true;
		} catch {
			setDeleteError(
				tlRef.current("Couldn't delete {name}", { name: item.name })
			);
			return false;
		} finally {
			setBusy(false);
		}
	}, [deleting]);

	return {
		beginRename,
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
	};
}

export type LibraryItemActions = ReturnType<typeof useLibraryItemActions>;

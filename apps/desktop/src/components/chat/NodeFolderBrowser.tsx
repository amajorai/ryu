"use client";

// apps/desktop/src/components/chat/NodeFolderBrowser.tsx
//
// Node-aware folder browser. Replaces the native OS folder picker (which only
// sees the desktop host) so a user can pick a project folder on the ACTIVE node
// even when that node is REMOTE. Lists directories over Core's
// `GET /api/workspace/list` (see lib/api/workspace.ts), lets the user descend
// into child folders / go up to the parent / jump home, and confirms a folder
// via `onSelect(path)`. The parent owns opening/closing and what a selection
// does (typically `setFolder`).

import {
	ArrowLeft01Icon,
	Folder03Icon,
	Home01Icon,
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
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type DirectoryListing,
	listDirectory,
} from "@/src/lib/api/workspace.ts";

interface NodeFolderBrowserProps {
	/** Called when the dialog requests to open/close. */
	onOpenChange: (open: boolean) => void;
	/** Called with the absolute path of the folder the user confirmed. */
	onSelect: (path: string) => void;
	/** Whether the dialog is open (controlled by the parent). */
	open: boolean;
}

/**
 * A dialog that browses the active node's filesystem and confirms a folder.
 * Starts at the node's home directory. Loading is keyed on the requested path so
 * navigating re-fetches; errors from the node (404/403) surface inline.
 */
export function NodeFolderBrowser({
	open,
	onOpenChange,
	onSelect,
}: NodeFolderBrowserProps) {
	const activeNode = useActiveNode();
	// `undefined` requests the node's home dir; a string requests that path.
	const [requestedPath, setRequestedPath] = useState<string | undefined>(
		undefined
	);
	const [listing, setListing] = useState<DirectoryListing | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset to home whenever the dialog is (re)opened so it never reopens deep in
	// a previous session's tree.
	useEffect(() => {
		if (open) {
			setRequestedPath(undefined);
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		let active = true;
		setLoading(true);
		setError(null);
		listDirectory(
			{ url: activeNode.url, token: activeNode.token ?? null },
			requestedPath
		)
			.then((result) => {
				if (active) {
					setListing(result);
				}
			})
			.catch((e: unknown) => {
				if (active) {
					setError(e instanceof Error ? e.message : "Could not list folder");
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [open, requestedPath, activeNode.url, activeNode.token]);

	const goHome = useCallback(() => {
		setRequestedPath(undefined);
	}, []);

	const goUp = useCallback(() => {
		if (listing?.parent) {
			setRequestedPath(listing.parent);
		}
	}, [listing?.parent]);

	const handleConfirm = useCallback(() => {
		if (listing) {
			onSelect(listing.path);
			onOpenChange(false);
		}
	}, [listing, onSelect, onOpenChange]);

	const currentPath = listing?.path ?? "";
	const canGoUp = Boolean(listing?.parent);
	const entries = listing?.entries ?? [];

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Open a folder</DialogTitle>
					<DialogDescription>
						Browse folders on{" "}
						{activeNode.name === "local"
							? "this computer"
							: `the "${activeNode.name}" node`}
						.
					</DialogDescription>
				</DialogHeader>

				{/* Path header + navigation controls. */}
				<div className="flex items-center gap-1.5">
					<Button
						aria-label="Go to home folder"
						className="size-8 shrink-0"
						onClick={goHome}
						size="icon"
						title="Home"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Home01Icon} />
					</Button>
					<Button
						aria-label="Go to parent folder"
						className="size-8 shrink-0"
						disabled={!canGoUp}
						onClick={goUp}
						size="icon"
						title="Parent folder"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
					</Button>
					<span
						className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[12px] text-foreground/80"
						title={currentPath}
					>
						{currentPath || "…"}
					</span>
				</div>

				{/* Folder list. */}
				<div className="h-64 overflow-y-auto rounded-lg border border-border">
					{loading && (
						<div className="flex h-full items-center justify-center">
							<Spinner />
						</div>
					)}
					{!loading && error && (
						<p className="px-3 py-2 text-[12px] text-destructive">{error}</p>
					)}
					{!(loading || error) && entries.length === 0 && (
						<p className="px-3 py-2 text-muted-foreground text-sm">
							No sub-folders here.
						</p>
					)}
					{!(loading || error) &&
						entries.map((entry) => (
							<button
								className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/10"
								key={entry.path}
								onClick={() => setRequestedPath(entry.path)}
								type="button"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-foreground/40"
									icon={Folder03Icon}
								/>
								<span className="min-w-0 flex-1 truncate text-foreground/80">
									{entry.name}
								</span>
							</button>
						))}
				</div>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button
						disabled={loading || !listing}
						onClick={handleConfirm}
						type="button"
					>
						Select this folder
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useCallback, useEffect, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { createProjectFolder } from "@/src/lib/api/workspace.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { useProjectOperationGuard } from "./ProjectPicker-operation-guard.ts";

/** Dialog to name and create a fresh project folder under Documents/Ryu, then open
 *  it. Controlled + rendered by the persistent picker parent (ProjectPicker /
 *  WorkspacePicker) so it outlives the project dialog that launches it. */
export function CreateFolderDialog({
	open: dialogOpen,
	onOpenChange,
	onFolderSelected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onFolderSelected?: (folder: string) => void;
}) {
	const setFolder = useWorkspaceStore((s) => s.setFolder);
	const activeNode = useActiveNode();
	const beginOperation = useProjectOperationGuard(dialogOpen);
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createdPath, setCreatedPath] = useState<string | null>(null);

	useEffect(() => {
		if (dialogOpen) {
			setCreating(false);
			setName("");
			setCreatedPath(null);
			setError(null);
		}
	}, [dialogOpen]);

	useEffect(() => {
		setCreatedPath(null);
		setCreating(false);
		setError(null);
	}, [activeNode.url, activeNode.token, activeNode.userJwt]);

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!(trimmed || createdPath) || creating) {
			return;
		}
		const operation = beginOperation();
		setCreating(true);
		setError(null);
		try {
			let created = createdPath;
			if (!created) {
				const result = await createProjectFolder(
					{
						url: operation.node.url,
						token: operation.node.token,
						userJwt: operation.node.userJwt ?? null,
					},
					trimmed
				);
				if (!operation.isCurrent()) {
					return;
				}
				if (!result.path) {
					setError(result.error ?? "Could not create the folder");
					return;
				}
				created = result.path;
				setCreatedPath(created);
			}

			try {
				if (
					!(
						(await setFolder(
							created,
							operation.getNode,
							operation.isCurrent
						)) && operation.isCurrent()
					)
				) {
					return;
				}
			} catch {
				if (!operation.isCurrent()) {
					return;
				}
				setError(
					"Created the folder, but could not open it. Try again to retry."
				);
				return;
			}

			if (!operation.isCurrent()) {
				return;
			}
			onFolderSelected?.(created);
			setName("");
			setCreatedPath(null);
			onOpenChange(false);
		} finally {
			operation.dispose();
			if (operation.isCurrent()) {
				setCreating(false);
			}
		}
	}, [
		name,
		creating,
		createdPath,
		activeNode.url,
		activeNode.token,
		activeNode.userJwt,
		beginOperation,
		setFolder,
		onOpenChange,
		onFolderSelected,
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
					aria-label="Project name"
					// dialog opened by explicit user action; focusing the sole field is expected
					autoFocus
					disabled={creating || Boolean(createdPath)}
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
				{error && (
					<p className="text-status-destructive text-xs" role="alert">
						{error}
					</p>
				)}
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button
						disabled={!createdPath && name.trim().length === 0}
						loading={creating}
						onClick={handleCreate}
						type="button"
					>
						{createdPath ? "Try opening project" : "Create project"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

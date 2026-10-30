"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
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
import {
	cloneProjectFolder,
	gitRepositoryName,
} from "@/src/lib/api/workspace.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { useProjectOperationGuard } from "./ProjectPicker-operation-guard.ts";

/** Dialog to clone a Git repository onto the active node, then open the
 * resulting checkout as the active project. The active node owns both the
 * destination filesystem and the SSH configuration used by a Git clone. */
export function CloneFolderDialog({
	activate = true,
	onFolderSelected,
	onOpenChange,
	open: dialogOpen,
}: {
	activate?: boolean;
	onFolderSelected?: (folder: string) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const setFolder = useWorkspaceStore((s) => s.setFolder);
	const activeNode = useActiveNode();
	const beginOperation = useProjectOperationGuard(dialogOpen);
	const tl = useLiteralMessages();
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [nameTouched, setNameTouched] = useState(false);
	const [cloning, setCloning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [clonedPath, setClonedPath] = useState<string | null>(null);

	useEffect(() => {
		if (dialogOpen) {
			setCloning(false);
			setUrl("");
			setName("");
			setNameTouched(false);
			setClonedPath(null);
			setError(null);
		}
	}, [dialogOpen]);

	useEffect(() => {
		setClonedPath(null);
		setCloning(false);
		setError(null);
	}, [activeNode.url, activeNode.token, activeNode.userJwt]);

	const handleClone = useCallback(async () => {
		const trimmedUrl = url.trim();
		if (!(trimmedUrl || clonedPath) || cloning) {
			return;
		}
		const operation = beginOperation();
		setCloning(true);
		setError(null);
		try {
			let cloned = clonedPath;
			if (!cloned) {
				const result = await cloneProjectFolder(
					{
						url: operation.node.url,
						token: operation.node.token,
						userJwt: operation.node.userJwt ?? null,
					},
					trimmedUrl,
					name
				);
				if (!operation.isCurrent()) {
					return;
				}
				if (!result.path) {
					setError(result.error ?? "Could not clone the repository");
					return;
				}
				cloned = result.path;
				setClonedPath(cloned);
			}
			if (activate) {
				try {
					if (
						!(
							(await setFolder(
								cloned,
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
						"Cloned the repository, but could not open it. Try again to retry."
					);
					return;
				}
			}
			if (!operation.isCurrent()) {
				return;
			}
			onFolderSelected?.(cloned);
			setUrl("");
			setName("");
			setNameTouched(false);
			setClonedPath(null);
			onOpenChange(false);
		} finally {
			operation.dispose();
			if (operation.isCurrent()) {
				setCloning(false);
			}
		}
	}, [
		activeNode.token,
		activeNode.userJwt,
		beginOperation,
		activeNode.url,
		activate,
		clonedPath,
		cloning,
		name,
		onFolderSelected,
		onOpenChange,
		setFolder,
		url,
	]);

	const locationLabel =
		activeNode.name === "local"
			? tl("this device")
			: tl('the "{name}" node', { name: activeNode.name });

	return (
		<Dialog onOpenChange={onOpenChange} open={dialogOpen}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Clone Git repository</DialogTitle>
					<DialogDescription>
						{tl(
							"Clone a GitHub, GitLab, Azure DevOps, or other Git repository onto {locationLabel}. HTTPS uses Git credentials configured on that node; SSH uses its configured keys. Don't put access tokens in the URL.",
							{ locationLabel }
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<label className="font-medium text-sm" htmlFor="git-clone-url">
							Repository URL
						</label>
						<Input
							aria-label="Repository URL"
							autoCapitalize="off"
							autoCorrect="off"
							disabled={cloning || Boolean(clonedPath)}
							id="git-clone-url"
							onChange={(event) => {
								const value = event.target.value;
								setUrl(value);
								if (!nameTouched) {
									setName(gitRepositoryName(value) ?? "");
								}
								setError(null);
							}}
							placeholder="https://gitlab.com/group/project.git"
							spellCheck={false}
							value={url}
							variant="code-caption"
						/>
						<p className="type-caption text-muted-foreground">
							Use an HTTPS or SSH clone URL. Private repositories use the Git
							credentials or SSH keys configured on this node.
						</p>
					</div>
					<div className="space-y-1.5">
						<label className="font-medium text-sm" htmlFor="git-clone-name">
							Folder name
						</label>
						<Input
							aria-label="Folder name"
							disabled={cloning || Boolean(clonedPath)}
							id="git-clone-name"
							onChange={(event) => {
								setNameTouched(true);
								setName(event.target.value);
								setError(null);
							}}
							placeholder="repo"
							value={name}
						/>
					</div>
					{error && (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					)}
				</div>
				<DialogFooter>
					<DialogClose render={<Button disabled={cloning} variant="ghost" />}>
						Cancel
					</DialogClose>
					<Button
						disabled={!(url.trim() || clonedPath)}
						loading={cloning}
						onClick={handleClone}
						type="button"
					>
						{clonedPath ? "Try opening project" : "Clone repository"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

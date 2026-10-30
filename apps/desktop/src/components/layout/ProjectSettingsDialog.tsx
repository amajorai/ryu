// Edit a project folder's display name + AGENTS.md instructions. Loads any
// existing AGENTS.md / agents.md / CLAUDE.md from the folder; first save creates
// AGENTS.md when none exists. Uses the same Plate MarkdownEditor as Spaces pages.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useRef, useState } from "react";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import { CloneFolderDialog } from "@/src/components/chat/ProjectPicker.tsx";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { request } from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import {
	basename,
	joinPath,
	resolveProjectAgentsFile,
	writeProjectFile,
} from "@/src/lib/files.ts";
import { sameFolder } from "@/src/lib/folder-path.ts";
import {
	findWorkspaceProject,
	primaryProjectFolder,
} from "@/src/lib/workspace-projects.ts";
import {
	type ProjectEnvironment,
	useWorkspaceStore,
} from "@/src/store/useWorkspaceStore.ts";
import { ProjectEnvironmentsSection } from "./ProjectSettingsDialog-environments-section.tsx";
import { projectRootMappingsResponseSchema } from "./ProjectSettingsDialog-mapping-schemas.ts";
import { ProjectMappingSection } from "./ProjectSettingsDialog-mapping-section.tsx";
import { ProjectSourceFoldersSection } from "./ProjectSettingsDialog-source-folders.tsx";

/** Controlled dialog to edit a project's label and on-disk AGENTS.md. */
export function ProjectSettingsDialog({
	path,
	open,
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	path: string;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const projectNames = useWorkspaceStore((s) => s.projectNames);
	const setProjectName = useWorkspaceStore((s) => s.setProjectName);
	const storedEnvironments = useWorkspaceStore(
		(s) => s.projectEnvironments[path]
	);
	const storedActiveEnvironment = useWorkspaceStore(
		(s) => s.activeProjectEnvironments[path]
	);
	const setProjectEnvironments = useWorkspaceStore(
		(s) => s.setProjectEnvironments
	);
	const project = useWorkspaceStore((s) =>
		findWorkspaceProject(s.projects, path)
	);
	const setProjectFolders = useWorkspaceStore((s) => s.setProjectFolders);
	const removeProject = useWorkspaceStore((s) => s.removeProject);
	const projectRoot =
		primaryProjectFolder(project ?? { folders: [path], id: path }) ?? path;
	const folderLeaf = basename(projectRoot);
	const storedName = project?.name ?? projectNames[projectRoot];

	const [name, setName] = useState(storedName ?? folderLeaf);
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [fileName, setFileName] = useState("AGENTS.md");
	const [filePath, setFilePath] = useState<string | null>(null);
	const [existed, setExisted] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const markdownRef = useRef("");
	const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
	const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(
		null
	);
	const [editingEnvironmentId, setEditingEnvironmentId] = useState<
		string | null
	>(null);
	const [mappingOrganizationId, setMappingOrganizationId] = useState("");
	const [mappingProjectId, setMappingProjectId] = useState("");
	const [loadedMapping, setLoadedMapping] = useState<{
		organizationId: string;
		projectId: string;
	} | null>(null);
	const [sourceFolders, setSourceFolders] = useState<string[]>([]);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [cloneOpen, setCloneOpen] = useState(false);

	// Reset + load when the dialog opens for a path.
	useEffect(() => {
		if (!open) {
			return;
		}
		const currentProject = findWorkspaceProject(
			useWorkspaceStore.getState().projects,
			path
		);
		const root =
			primaryProjectFolder(currentProject ?? { folders: [path], id: path }) ??
			path;
		const leaf = basename(root);
		const label =
			currentProject?.name ??
			useWorkspaceStore.getState().projectNames[root] ??
			leaf;
		setName(label);
		setSourceFolders(currentProject?.folders ?? [path]);
		setMarkdown(null);
		setLoadError(null);
		setSaveError(null);
		setFileName("AGENTS.md");
		setFilePath(null);
		setExisted(false);
		markdownRef.current = "";
		const nextEnvironments = structuredClone(storedEnvironments ?? []);
		setEnvironments(nextEnvironments);
		const nextActive =
			storedActiveEnvironment ?? nextEnvironments[0]?.id ?? null;
		setActiveEnvironmentId(nextActive);
		setEditingEnvironmentId(nextActive);
		request(
			{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
			"/api/org-project-mappings",
			undefined,
			projectRootMappingsResponseSchema
		)
			.then(({ mappings }) => {
				const mapping = mappings.find((item) => item.root === root) ?? null;
				setLoadedMapping(mapping);
				setMappingOrganizationId(mapping?.organizationId ?? "");
				setMappingProjectId(mapping?.projectId ?? "");
			})
			.catch(() => {
				setLoadedMapping(null);
				setMappingOrganizationId("");
				setMappingProjectId("");
			});

		let cancelled = false;
		resolveProjectAgentsFile(root)
			.then((resolved) => {
				if (cancelled) {
					return;
				}
				markdownRef.current = resolved.content;
				setMarkdown(resolved.content);
				setFileName(resolved.fileName);
				setFilePath(resolved.path);
				setExisted(resolved.existed);
			})
			.catch((e) => {
				if (cancelled) {
					return;
				}
				console.error("Failed to load project instructions", e);
				setLoadError(
					"Couldn't read this folder's instruction file. Check the path is reachable."
				);
				setMarkdown("");
				setFilePath(null);
			});
		return () => {
			cancelled = true;
		};
	}, [
		node.token,
		node.url,
		open,
		path,
		projectRoot,
		project?.id,
		storedActiveEnvironment,
		storedEnvironments,
	]);

	const handleSave = async () => {
		if (saving || markdown === null) {
			return;
		}
		const trimmedName = name.trim();
		if (!trimmedName) {
			toast.error("Name can't be empty");
			return;
		}
		if (environments.some((environment) => !environment.name.trim())) {
			toast.error("Environment names can't be empty");
			return;
		}
		if (
			Boolean(mappingOrganizationId.trim()) !== Boolean(mappingProjectId.trim())
		) {
			toast.error(
				"Organization ID and project ID are both required for a mapping"
			);
			return;
		}
		for (const environment of environments) {
			const variableKeys = environment.variables
				.map((variable) => variable.key.trim())
				.filter(Boolean);
			if (variableKeys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
				toast.error(
					tl("Invalid variable name in {name}", { name: environment.name })
				);
				return;
			}
			if (new Set(variableKeys).size !== variableKeys.length) {
				toast.error(
					tl("Duplicate variable name in {name}", { name: environment.name })
				);
				return;
			}
			if (environment.actions.some((action) => !action.name.trim())) {
				toast.error(
					tl("Action names can't be empty in {name}", {
						name: environment.name,
					})
				);
				return;
			}
		}
		const targetPath =
			filePath ?? joinPath(projectRoot, fileName || "AGENTS.md");
		setSaveError(null);
		setSaving(true);
		try {
			await writeProjectFile(targetPath, markdownRef.current);
			const apiTarget = {
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			};
			if (mappingOrganizationId.trim() && mappingProjectId.trim()) {
				await request(
					apiTarget,
					"/api/org-project-mappings",
					{
						body: {
							organizationId: mappingOrganizationId.trim(),
							projectId: mappingProjectId.trim(),
							root: projectRoot,
						},
						method: "PUT",
					},
					gatewayJsonValueSchema
				);
			} else if (loadedMapping) {
				const query = new URLSearchParams({
					organizationId: loadedMapping.organizationId,
					projectId: loadedMapping.projectId,
					root: projectRoot,
				});
				await request(
					apiTarget,
					`/api/org-project-mappings?${query}`,
					{
						method: "DELETE",
					},
					gatewayJsonValueSchema
				);
			}
			// Empty / basename-equal clears the override so the leaf stays the source of truth.
			setProjectName(
				project?.id ?? projectRoot,
				trimmedName === folderLeaf ? "" : trimmedName
			);
			setProjectFolders(project?.id ?? projectRoot, sourceFolders);
			setProjectEnvironments(
				sourceFolders[0] ?? projectRoot,
				environments,
				activeEnvironmentId
			);
			onOpenChange(false);
			toast.success(
				existed ? `Saved ${fileName}` : `Created ${basename(targetPath)}`,
				{
					description: existed
						? "Project instructions updated."
						: "Project instructions file created in this folder.",
				}
			);
		} catch (e) {
			console.error("Failed to save project settings", e);
			setSaveError(
				"Couldn't save project settings. Check that the project folder and node are writable, then try again."
			);
			toast.error("Couldn't save project settings", {
				description:
					"Check that the project folder and node are writable, then try again.",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<Dialog onOpenChange={onOpenChange} open={open}>
				<DialogContent appearance="project-settings">
					<DialogHeader className="shrink-0" purpose="project-settings">
						<DialogTitle>Edit project</DialogTitle>
						<DialogDescription>
							Set how this folder appears in the sidebar and the instructions
							agents read from{" "}
							<code className="rounded bg-muted px-1 font-mono text-xs">
								{fileName}
							</code>
							.
						</DialogDescription>
					</DialogHeader>
					{saveError ? (
						<div className="shrink-0 px-6 pt-3">
							<p
								className="rounded-md border border-status-destructive/40 bg-status-destructive/10 px-3 py-2 text-sm text-status-destructive"
								role="alert"
							>
								{saveError}
							</p>
						</div>
					) : null}

					<div className="scroll-fade flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="project-settings-name">Name</Label>
							<Input
								// dialog opened by explicit user action
								autoFocus
								disabled={saving}
								id="project-settings-name"
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
										e.preventDefault();
									}
								}}
								placeholder={folderLeaf}
								spellCheck={false}
								value={name}
							/>
							<p className="text-muted-foreground text-xs">
								Shown in the sidebar. The folder path on disk stays the same.
							</p>
						</div>

						<ProjectSourceFoldersSection
							saving={saving}
							setBrowseOpen={setBrowseOpen}
							setCloneOpen={setCloneOpen}
							setSourceFolders={setSourceFolders}
							sourceFolders={sourceFolders}
						/>

						<div className="flex shrink-0 flex-col gap-1.5">
							<Label htmlFor="project-settings-instructions">
								Instructions
								{!existed && markdown !== null ? (
									<span className="ml-2 font-normal text-muted-foreground">
										{tl("— will create {fileName} on save", { fileName })}
									</span>
								) : null}
							</Label>
							{loadError ? (
								<p className="text-sm text-status-destructive">{loadError}</p>
							) : null}
							{markdown === null ? (
								<SkeletonRows rows={6} spacing="library" />
							) : (
								<div
									className="min-h-48 shrink-0 overflow-hidden rounded-md border"
									id="project-settings-instructions"
								>
									<MarkdownEditor
										compact
										initialMarkdown={markdown}
										key={`${path}:${filePath ?? "new"}`}
										onChangeMarkdown={(next) => {
											markdownRef.current = next;
										}}
									/>
								</div>
							)}
							<p className="text-muted-foreground text-xs">
								Same editor as Spaces pages. Agents pick up{" "}
								<code className="rounded bg-muted px-1 font-mono text-xs">
									AGENTS.md
								</code>{" "}
								(or an existing{" "}
								<code className="rounded bg-muted px-1 font-mono text-xs">
									CLAUDE.md
								</code>
								) at the project root.
							</p>
						</div>

						<ProjectMappingSection
							mappingOrganizationId={mappingOrganizationId}
							mappingProjectId={mappingProjectId}
							setMappingOrganizationId={setMappingOrganizationId}
							setMappingProjectId={setMappingProjectId}
						/>

						<ProjectEnvironmentsSection
							activeEnvironmentId={activeEnvironmentId}
							editingEnvironmentId={editingEnvironmentId}
							environments={environments}
							setActiveEnvironmentId={setActiveEnvironmentId}
							setEditingEnvironmentId={setEditingEnvironmentId}
							setEnvironments={setEnvironments}
						/>
					</div>

					<DialogFooter
						className="shrink-0 justify-between"
						purpose="panel-actions"
					>
						<Button
							disabled={saving}
							onClick={() => {
								removeProject(project?.id ?? projectRoot);
								onOpenChange(false);
							}}
							type="button"
							variant="destructive"
						>
							Remove local project
						</Button>
						<div className="flex items-center gap-2">
							<Button
								disabled={saving}
								onClick={() => onOpenChange(false)}
								type="button"
								variant="ghost"
							>
								Cancel
							</Button>
							<Button
								disabled={markdown === null || name.trim().length === 0}
								loading={saving}
								onClick={() => {
									handleSave().catch(() => undefined);
								}}
								type="button"
							>
								Save
							</Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={(selected) => {
					setSourceFolders((current) =>
						current.some((folder) => sameFolder(folder, selected))
							? current
							: [...current, selected]
					);
				}}
				open={browseOpen}
			/>
			<CloneFolderDialog
				activate={false}
				onFolderSelected={(selected) => {
					setSourceFolders((current) =>
						current.some((folder) => sameFolder(folder, selected))
							? current
							: [...current, selected]
					);
				}}
				onOpenChange={setCloneOpen}
				open={cloneOpen}
			/>
		</>
	);
}

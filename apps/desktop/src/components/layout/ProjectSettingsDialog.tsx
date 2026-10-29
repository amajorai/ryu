import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// Edit a project folder's display name + AGENTS.md instructions. Loads any
// existing AGENTS.md / agents.md / CLAUDE.md from the folder; first save creates
// AGENTS.md when none exists. Uses the same Plate MarkdownEditor as Spaces pages.

import {
	Add01Icon,
	Cancel01Icon,
	Delete02Icon,
	Folder03Icon,
	FolderAddIcon,
	PlayIcon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef, useState } from "react";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import { CloneFolderDialog } from "@/src/components/chat/ProjectPicker.tsx";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { request } from "@/src/lib/api/client.ts";
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
	promoteProjectFolder,
} from "@/src/lib/workspace-projects.ts";
import {
	emptyEnvironmentScripts,
	type ProjectEnvironment,
	type ProjectEnvironmentScripts,
	useWorkspaceStore,
} from "@/src/store/useWorkspaceStore.ts";

const SCRIPT_PLATFORMS = ["default", "macos", "linux", "windows"] as const;
type ScriptPlatform = (typeof SCRIPT_PLATFORMS)[number];

const newId = (): string => crypto.randomUUID();

const newEnvironment = (name = "Local"): ProjectEnvironment => ({
	id: newId(),
	name,
	setup: emptyEnvironmentScripts(),
	cleanup: emptyEnvironmentScripts(),
	variables: [],
	actions: [],
});

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
				toast.error(`Invalid variable name in ${environment.name}`);
				return;
			}
			if (new Set(variableKeys).size !== variableKeys.length) {
				toast.error(`Duplicate variable name in ${environment.name}`);
				return;
			}
			if (environment.actions.some((action) => !action.name.trim())) {
				toast.error(`Action names can't be empty in ${environment.name}`);
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
							<code className="type-caption rounded bg-muted px-1 font-mono">
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

						<section className="flex flex-col gap-1.5">
							<Label>Source folders</Label>
							<p className="text-muted-foreground text-xs">
								Add folders agents can read and edit. The first folder is the
								primary project workspace.
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
													aria-label={`Make ${folder} primary`}
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
												aria-label={`Remove ${folder}`}
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

						<div className="flex shrink-0 flex-col gap-1.5">
							<Label htmlFor="project-settings-instructions">
								Instructions
								{!existed && markdown !== null ? (
									<span className="ml-2 font-normal text-muted-foreground">
										— will create {fileName} on save
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
								<code className="type-caption rounded bg-muted px-1 font-mono">
									AGENTS.md
								</code>{" "}
								(or an existing{" "}
								<code className="type-caption rounded bg-muted px-1 font-mono">
									CLAUDE.md
								</code>
								) at the project root.
							</p>
						</div>

						<section className="flex flex-col gap-3 border-t pt-4">
							<div>
								<h3 className="font-medium text-sm">Managed project mapping</h3>
								<p className="text-muted-foreground text-xs">
									Map this local folder to a control-plane project. The folder
									path stays on this node.
								</p>
							</div>
							<div className="grid gap-3 sm:grid-cols-2">
								<div className="space-y-1.5">
									<Label htmlFor="project-mapping-organization">
										Organization ID
									</Label>
									<Input
										id="project-mapping-organization"
										onChange={(event) =>
											setMappingOrganizationId(event.target.value)
										}
										placeholder="Organization ID"
										value={mappingOrganizationId}
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="project-mapping-project">Project ID</Label>
									<Input
										id="project-mapping-project"
										onChange={(event) =>
											setMappingProjectId(event.target.value)
										}
										placeholder="Project ID"
										value={mappingProjectId}
									/>
								</div>
							</div>
						</section>

						<section className="flex flex-col gap-3 border-t pt-4">
							<div className="flex items-start justify-between gap-4">
								<div>
									<h3 className="font-medium text-sm">Local environments</h3>
									<p className="text-muted-foreground text-xs">
										Named setups for worktrees, agent processes, and project
										actions.
									</p>
								</div>
								<Button
									onClick={() => {
										const environment = newEnvironment(
											`Local ${environments.length + 1}`
										);
										setEnvironments((current) => [...current, environment]);
										setEditingEnvironmentId(environment.id);
										setActiveEnvironmentId(
											(current) => current ?? environment.id
										);
									}}
									size="sm"
									type="button"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									Add environment
								</Button>
							</div>

							{environments.length === 0 ? (
								<button
									className="rounded-lg border border-dashed px-4 py-8 text-muted-foreground text-sm transition-colors hover:bg-muted/40"
									onClick={() => {
										const environment = newEnvironment();
										setEnvironments([environment]);
										setEditingEnvironmentId(environment.id);
										setActiveEnvironmentId(environment.id);
									}}
									type="button"
								>
									Add a local environment setup
								</button>
							) : (
								<>
									<div className="flex flex-wrap gap-1">
										{environments.map((environment) => (
											<button
												className={cn(
													"rounded-md px-3 py-1.5 text-xs transition-colors",
													editingEnvironmentId === environment.id
														? "bg-foreground text-background"
														: "bg-muted text-muted-foreground hover:text-foreground"
												)}
												key={environment.id}
												onClick={() => setEditingEnvironmentId(environment.id)}
												type="button"
											>
												{environment.name}
												{activeEnvironmentId === environment.id
													? " · Active"
													: ""}
											</button>
										))}
									</div>
									{environments.map((environment) =>
										environment.id === editingEnvironmentId ? (
											<EnvironmentEditor
												environment={environment}
												isActive={activeEnvironmentId === environment.id}
												key={environment.id}
												onChange={(next) =>
													setEnvironments((current) =>
														current.map((item) =>
															item.id === next.id ? next : item
														)
													)
												}
												onDelete={() => {
													const remaining = environments.filter(
														(item) => item.id !== environment.id
													);
													setEnvironments(remaining);
													setEditingEnvironmentId(remaining[0]?.id ?? null);
													if (activeEnvironmentId === environment.id) {
														setActiveEnvironmentId(remaining[0]?.id ?? null);
													}
												}}
												onMakeActive={() =>
													setActiveEnvironmentId(environment.id)
												}
											/>
										) : null
									)}
								</>
							)}
						</section>
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

function EnvironmentEditor({
	environment,
	isActive,
	onChange,
	onDelete,
	onMakeActive,
}: {
	environment: ProjectEnvironment;
	isActive: boolean;
	onChange: (environment: ProjectEnvironment) => void;
	onDelete: () => void;
	onMakeActive: () => void;
}) {
	return (
		<div className="flex flex-col gap-4 rounded-lg border bg-muted/15 p-4">
			<div className="flex items-end gap-2">
				<div className="min-w-0 flex-1 space-y-1.5">
					<Label htmlFor={`environment-${environment.id}-name`}>Name</Label>
					<Input
						id={`environment-${environment.id}-name`}
						onChange={(event) =>
							onChange({ ...environment, name: event.target.value })
						}
						placeholder="Local"
						value={environment.name}
					/>
				</div>
				<Button
					disabled={isActive}
					onClick={onMakeActive}
					type="button"
					variant="ghost"
				>
					{isActive ? "Active" : "Make active"}
				</Button>
				<Button
					aria-label={`Delete ${environment.name}`}
					onClick={onDelete}
					size="icon"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				</Button>
			</div>

			<div className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-muted-foreground text-xs">
				Setup and cleanup shell hooks are unavailable for chat worktrees. Use a
				local action or a reviewed project instruction instead; environment
				variables remain available to the coding agent.
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<div>
						<Label>Variables</Label>
						<p className="text-muted-foreground text-xs">
							Inherited by actions and the coding agent. Do not store secrets
							here.
						</p>
					</div>
					<Button
						onClick={() =>
							onChange({
								...environment,
								variables: [
									...environment.variables,
									{ id: newId(), key: "", value: "" },
								],
							})
						}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add variable
					</Button>
				</div>
				{environment.variables.map((variable) => (
					<div className="flex gap-2" key={variable.id}>
						<Input
							aria-label="Variable name"
							onChange={(event) =>
								onChange({
									...environment,
									variables: environment.variables.map((item) =>
										item.id === variable.id
											? { ...item, key: event.target.value }
											: item
									),
								})
							}
							placeholder="DATABASE_URL"
							value={variable.key}
							variant="code"
						/>
						<Input
							aria-label="Variable value"
							onChange={(event) =>
								onChange({
									...environment,
									variables: environment.variables.map((item) =>
										item.id === variable.id
											? { ...item, value: event.target.value }
											: item
									),
								})
							}
							placeholder="value"
							value={variable.value}
							variant="code"
						/>
						<Button
							aria-label={`Remove ${variable.key || "variable"}`}
							onClick={() =>
								onChange({
									...environment,
									variables: environment.variables.filter(
										(item) => item.id !== variable.id
									),
								})
							}
							size="icon"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</Button>
					</div>
				))}
			</div>

			<div className="space-y-2 border-t pt-4">
				<div className="flex items-center justify-between">
					<div>
						<Label>Actions</Label>
						<p className="text-muted-foreground text-xs">
							Commands shown beside the active environment in the workspace bar.
						</p>
					</div>
					<Button
						onClick={() =>
							onChange({
								...environment,
								actions: [
									...environment.actions,
									{
										id: newId(),
										name: "Run",
										scripts: emptyEnvironmentScripts(),
									},
								],
							})
						}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add action
					</Button>
				</div>
				{environment.actions.map((action) => (
					<div className="rounded-md border bg-background p-3" key={action.id}>
						<div className="mb-3 flex gap-2">
							<HugeiconsIcon
								className="mt-2.5 size-4 text-muted-foreground"
								icon={PlayIcon}
							/>
							<Input
								aria-label="Action name"
								onChange={(event) =>
									onChange({
										...environment,
										actions: environment.actions.map((item) =>
											item.id === action.id
												? { ...item, name: event.target.value }
												: item
										),
									})
								}
								placeholder="Dev stack"
								value={action.name}
							/>
							<Button
								aria-label={`Remove ${action.name}`}
								onClick={() =>
									onChange({
										...environment,
										actions: environment.actions.filter(
											(item) => item.id !== action.id
										),
									})
								}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							</Button>
						</div>
						<ScriptEditor
							compact
							label="Command"
							onChange={(scripts) =>
								onChange({
									...environment,
									actions: environment.actions.map((item) =>
										item.id === action.id ? { ...item, scripts } : item
									),
								})
							}
							placeholder="bun run dev"
							scripts={action.scripts}
						/>
					</div>
				))}
			</div>
		</div>
	);
}

function ScriptEditor({
	compact = false,
	description,
	label,
	onChange,
	placeholder,
	scripts,
}: {
	compact?: boolean;
	description?: string;
	label: string;
	onChange: (scripts: ProjectEnvironmentScripts) => void;
	placeholder: string;
	scripts: ProjectEnvironmentScripts;
}) {
	const [platform, setPlatform] = useState<ScriptPlatform>("default");
	return (
		<div className="space-y-1.5">
			<div>
				<Label>{label}</Label>
				{description ? (
					<p className="text-muted-foreground text-xs">{description}</p>
				) : null}
			</div>
			<div className="flex gap-1">
				{SCRIPT_PLATFORMS.map((item) => (
					<button
						className={cn(
							"rounded-md px-2 py-1 text-xs capitalize",
							platform === item
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						key={item}
						onClick={() => setPlatform(item)}
						type="button"
					>
						{item === "default" ? "Default" : item}
					</button>
				))}
			</div>
			<Textarea
				className={cn("resize-y", compact ? "min-h-20" : "min-h-28")}
				onChange={(event) =>
					onChange({ ...scripts, [platform]: event.target.value })
				}
				placeholder={
					platform === "default"
						? placeholder
						: `Overrides Default on ${platform}`
				}
				spellCheck={false}
				value={scripts[platform]}
				variant="code-caption"
			/>
		</div>
	);
}

const projectRootMappingResponseSchema = z
	.object({
		organizationId: z.string(),
		projectId: z.string(),
		root: z.string(),
	})
	.passthrough();

const projectRootMappingsResponseSchema = z
	.object({ mappings: z.array(projectRootMappingResponseSchema) })
	.passthrough();

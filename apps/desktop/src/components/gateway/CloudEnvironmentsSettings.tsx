import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { Button } from "@ryu/ui/components/button.tsx";

import { Checkbox } from "@ryu/ui/components/checkbox.tsx";

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

import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";

import { Switch } from "@ryu/ui/components/switch.tsx";

import { Textarea } from "@ryu/ui/components/textarea.tsx";

import {
	CLOUD_ENVIRONMENT_LIFETIME_MINUTES,
	type CloudEnvironmentRuntime,
	cloudEnvironmentRuntimeIssue,
	DEFAULT_CLOUD_ENVIRONMENT_RUNTIME,
} from "@ryuhq/protocol/cloud-environments";

import { useCallback, useEffect, useRef, useState } from "react";
import { SubscriptionBackendsSettings } from "@/src/components/gateway/SubscriptionBackendsSettings.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";

import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";

import {
	type CloudEnvironment,
	type CloudEnvironmentsSnapshot,
	type CloudEnvironmentWrite,
	type CloudVaultEntry,
	type CloudVaultEntryWrite,
	type CloudVaultKind,
	fetchCloudEnvironments,
	fetchImportVariableNames,
	fetchSharedCloudEnvironments,
	importCloudVariables,
	importSharedCloudEnvironment,
	invokeCloudEnvironmentSelectedVariables,
	isLocalCloudVariableImport,
	parseEnvironmentPaste,
	runCloudEnvironmentSetup,
	saveCloudEnvironments,
} from "@/src/lib/api/cloud-environments.ts";
import { SettingsNotice } from "./SettingsNotice.tsx";

const lines = (value: string) =>
	value
		.split(/\r?\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);

const errorMessage = <TError,>(error: TError) =>
	error instanceof ApiError && error.serverMessage
		? error.serverMessage
		: error instanceof Error
			? error.message
			: "Could not update cloud environments";

// Parser/validation messages ("Invalid cloud environment state", a serialized
// issue list) are not sentences a person can act on. They headline as a plain
// sentence and stay available on hover; server messages read as written.
const TECHNICAL_ERROR = /^(?:invalid cloud environment|[[{])/iu;

const paneErrorHeadline = (error: string) =>
	TECHNICAL_ERROR.test(error.trim())
		? "Couldn’t read the saved cloud environment settings."
		: error;

const createEnvironment = (): CloudEnvironment => ({
	id: crypto.randomUUID(),
	name: "New environment",
	repositories: [],
	installScript: "",
	startInstructions: "",
	internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
	privacy: "private",
	vaultKeys: [],
	tailscaleVaultKey: null,
	published: false,
	runtime: { ...DEFAULT_CLOUD_ENVIRONMENT_RUNTIME },
});

const RUNTIME_AGENT_OPTIONS = [
	["ryu", "Ryu"],
	["claude-code", "Claude Code"],
	["codex", "Codex"],
	["opencode", "OpenCode"],
	["cursor", "Cursor"],
] as const satisfies readonly (readonly [
	CloudEnvironmentRuntime["executor"],
	string,
])[];

const runtimeExecutor = (
	value: string
): CloudEnvironmentRuntime["executor"] | null =>
	RUNTIME_AGENT_OPTIONS.find(([option]) => option === value)?.[0] ?? null;

export function CloudEnvironmentsSettings({
	target,
	startCreate = false,
	initialRepository,
	initialVaultKey,
}: {
	target?: ApiTarget;
	startCreate?: boolean;
	initialRepository?: string;
	initialVaultKey?: string;
}) {
	return target ? (
		<TargetCloudEnvironmentsSettings
			initialRepository={initialRepository}
			initialVaultKey={initialVaultKey}
			key={cloudTargetKey(target)}
			startCreate={startCreate}
			target={target}
		/>
	) : (
		<ActiveNodeCloudEnvironmentsSettings />
	);
}

const cloudTargetKey = (target: ApiTarget) =>
	`${target.url}\u0000${target.token ?? ""}\u0000${target.userJwt ?? ""}`;

function ActiveNodeCloudEnvironmentsSettings() {
	const node = useActiveNode();
	const target = {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	return (
		<TargetCloudEnvironmentsSettings
			key={cloudTargetKey(target)}
			target={target}
		/>
	);
}

function TargetCloudEnvironmentsSettings({
	target,
	startCreate = false,
	initialRepository,
	initialVaultKey,
}: {
	target: ApiTarget;
	startCreate?: boolean;
	initialRepository?: string;
	initialVaultKey?: string;
}) {
	const startedCreating = useRef(false);
	const [snapshot, setSnapshot] = useState<CloudEnvironmentsSnapshot | null>(
		null
	);

	const [tab, setTab] = useState<"environments" | "vault">("environments");

	const [search, setSearch] = useState("");
	const [vaultFilter, setVaultFilter] = useState<CloudVaultKind | "all">("all");

	const [error, setError] = useState<string | null>(null);

	const [busy, setBusy] = useState(false);

	const [editing, setEditing] = useState<CloudEnvironment | null>(null);
	useEffect(() => {
		if (startCreate && snapshot && !startedCreating.current) {
			startedCreating.current = true;
			setEditing({
				...createEnvironment(),
				...(initialRepository
					? {
							name: initialRepository.split("/").at(-1) ?? "New environment",
							repositories: [initialRepository],
						}
					: undefined),
				vaultKeys: initialVaultKey ? [initialVaultKey] : [],
			});
		}
	}, [snapshot, startCreate, initialRepository, initialVaultKey]);

	const [vaultOpen, setVaultOpen] = useState(false);

	const [editingVault, setEditingVault] = useState<CloudVaultEntry | null>(
		null
	);

	const [shared, setShared] = useState<CloudEnvironment[] | null>(null);

	const [importOpen, setImportOpen] = useState(false);

	const [result, setResult] = useState<string | null>(null);

	const [deleting, setDeleting] = useState<CloudVaultEntry | null>(null);

	const load = useCallback(
		async (signal?: AbortSignal) => {
			setError(null);

			try {
				setSnapshot(
					await fetchCloudEnvironments(
						{ url: target.url, token: target.token, userJwt: target.userJwt },
						signal
					)
				);
			} catch (failure) {
				if (!signal?.aborted) {
					setError(errorMessage(failure));
				}
			}
		},
		[target.url, target.token, target.userJwt]
	);

	useEffect(() => {
		const controller = new AbortController();
		setSnapshot(null);
		load(controller.signal).catch(() => undefined);
		return () => controller.abort();
	}, [load]);

	const save = async (next: CloudEnvironmentWrite) => {
		setBusy(true);
		setError(null);

		try {
			setSnapshot(
				await saveCloudEnvironments(target, {
					...next,
					vault: next.vault.map((entry) => ({
						id: entry.id,
						key: entry.key,
						kind: entry.kind,
						environmentIds: entry.environmentIds,
						domains: entry.domains,
						...(entry.value === undefined ? undefined : { value: entry.value }),
					})),
				})
			);
			return true;
		} catch (failure) {
			setError(errorMessage(failure));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const saveEnvironment = async (
		environment: CloudEnvironment,
		entries: CloudVaultEntryWrite[] = []
	) => {
		if (!snapshot) {
			return;
		}

		const environments = snapshot.environments.some(
			(item) => item.id === environment.id
		)
			? snapshot.environments.map((item) =>
					item.id === environment.id ? environment : item
				)
			: [...snapshot.environments, environment];

		const keys = new Set(entries.map((entry) => entry.key));
		if (
			await save({
				...snapshot,
				environments,
				vault: [
					...snapshot.vault.filter((entry) => !keys.has(entry.key)),
					...entries,
				],
			})
		) {
			setEditing(null);
		}
	};
	const matchingEnvironments =
		snapshot?.environments.filter((item) =>
			`${item.name} ${item.repositories.join(" ")}`
				.toLowerCase()
				.includes(search.toLowerCase())
		) ?? [];
	const matchingVault =
		snapshot?.vault.filter(
			(item) =>
				item.key.toLowerCase().includes(search.toLowerCase()) &&
				(vaultFilter === "all" || item.kind === vaultFilter)
		) ?? [];

	const runSetup = async (environment: CloudEnvironment) => {
		setBusy(true);
		setError(null);

		try {
			const output = await runCloudEnvironmentSetup(target, environment.id);

			setResult(
				`Setup exited with code ${output.exitCode}\n\n${output.stdout}\n${output.stderr}`
			);
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const tabEntries =
		tab === "environments" ? snapshot?.environments : snapshot?.vault;
	const tabMatches =
		tab === "environments" ? matchingEnvironments : matchingVault;

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Save repository setup, task instructions, network access, and credentials on the selected node. Personal vault values stay hidden after saving."
				headerAction={
					tab === "environments" ? (
						<Button
							disabled={!snapshot || busy}
							onClick={() => {
								setError(null);
								setEditing(createEnvironment());
							}}
							size="sm"
						>
							Create environment
						</Button>
					) : (
						<div className="flex items-center gap-2">
							<Button
								disabled={!snapshot || busy}
								onClick={() => setImportOpen(true)}
								size="sm"
								variant="outline"
							>
								{isLocalCloudVariableImport()
									? "Import from computer"
									: "Import from node"}
							</Button>
							<Button
								disabled={!snapshot || busy}
								onClick={() => {
									setEditingVault(null);
									setVaultOpen(true);
								}}
								size="sm"
							>
								Add
							</Button>
						</div>
					)
				}
				title="Cloud environments"
			>
				{/* Segmented control above the list it switches, as in Apple's
				    Settings; the search field (and the vault's type filter) sit
				    directly under it. */}
				<div className="flex w-full items-center gap-0.5 rounded-lg bg-muted p-0.5">
					{(
						[
							["environments", "Environments"],
							["vault", "Personal vault"],
						] as const
					).map(([value, label]) => (
						<button
							aria-pressed={tab === value}
							className={`flex-1 rounded-md px-3 py-1 text-sm transition-colors ${
								tab === value
									? "bg-background font-medium text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
							key={value}
							onClick={() => setTab(value)}
							type="button"
						>
							{label}
						</button>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Input
						aria-label="Search cloud environments and vault"
						className="min-w-36 flex-1"
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search"
						value={search}
					/>
					{tab === "vault" ? (
						<NativeSelect
							aria-label="Filter vault entry types"
							onChange={(event) =>
								setVaultFilter(
									event.target.value === "variable" ||
										event.target.value === "networkSecret"
										? event.target.value
										: "all"
								)
							}
							value={vaultFilter}
						>
							<NativeSelectOption value="all">All types</NativeSelectOption>
							<NativeSelectOption value="variable">
								Environment variables
							</NativeSelectOption>
							<NativeSelectOption value="networkSecret">
								Network secrets
							</NativeSelectOption>
						</NativeSelect>
					) : null}
				</div>

				{error ? (
					<SettingsNotice
						action={
							<Button
								disabled={busy}
								onClick={() => load()}
								size="sm"
								variant="outline"
							>
								Reload saved settings
							</Button>
						}
						detail={error}
						role="alert"
					>
						{paneErrorHeadline(error)}
					</SettingsNotice>
				) : null}

				{snapshot || error ? null : (
					<SettingsNotice role="status">
						Loading cloud environments…
					</SettingsNotice>
				)}

				{snapshot && tabMatches.length > 0 ? (
					<SettingsGroup>
						{tab === "environments"
							? matchingEnvironments.map((item) => (
									<SettingsItem
										actions={
											<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
												<Button
													disabled={busy}
													onClick={() => {
														setError(null);
														setEditing(structuredClone(item));
													}}
													size="sm"
													variant="ghost"
												>
													Edit
												</Button>
												{item.published ? (
													<Button
														disabled={busy}
														onClick={() => runSetup(item)}
														size="sm"
														variant="outline"
													>
														Run setup check
													</Button>
												) : null}
											</div>
										}
										description={`${item.repositories.join(", ") || "No repositories"} · ${item.privacy === "private" ? "Private" : "Shared"} · ${item.published ? "Published" : "Draft"}`}
										key={item.id}
										title={item.name}
									/>
								))
							: matchingVault.map((item) => (
									<SettingsItem
										actions={
											<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
												<span
													aria-label={
														item.hasValue ? "Value hidden" : "Value not set"
													}
													className="text-muted-foreground"
												>
													{item.hasValue ? "••••••••" : "Not set"}
												</span>
												<Button
													disabled={busy}
													onClick={() => {
														setError(null);
														setEditingVault(item);
														setVaultOpen(true);
													}}
													size="sm"
													variant="ghost"
												>
													Edit
												</Button>
												<Button
													disabled={busy}
													onClick={() => setDeleting(item)}
													size="sm"
													variant="ghost"
												>
													Delete
												</Button>
											</div>
										}
										description={`${item.kind === "variable" ? "Environment variable" : "Network secret"} · ${item.environmentIds.length ? "Selected environments" : "All environments"}`}
										key={item.id}
										title={item.key}
									/>
								))}
					</SettingsGroup>
				) : null}

				{tabEntries?.length === 0 ? (
					<SettingsCard>
						<p className="text-center text-muted-foreground text-sm">
							{tab === "environments"
								? "No cloud environments yet. Create one to save your repository setup."
								: "No vault entries yet. Add a variable or a network secret."}
						</p>
					</SettingsCard>
				) : null}
				{tabEntries && tabEntries.length > 0 && tabMatches.length === 0 ? (
					<SettingsCard>
						<p
							className="text-center text-muted-foreground text-sm"
							role="status"
						>
							No matching{" "}
							{tab === "environments" ? "environments" : "vault entries"}.
						</p>
					</SettingsCard>
				) : null}
			</SettingsSection>

			<SubscriptionBackendsSettings
				environments={(snapshot?.environments ?? [])
					.filter((environment) => environment.published)
					.map(({ id, name }) => ({ id, name }))}
				target={target}
			/>

			{snapshot ? (
				<SettingsSection
					caption="Import a published template as your own private draft. Personal credentials are never included."
					headerAction={
						<Button
							disabled={busy}
							onClick={async () => {
								setError(null);
								try {
									setShared(await fetchSharedCloudEnvironments(target));
								} catch (failure) {
									setError(errorMessage(failure));
								}
							}}
							size="sm"
							variant="outline"
						>
							Browse shared templates
						</Button>
					}
					title="Shared environment templates"
				>
					{shared && shared.length > 0 ? (
						<SettingsGroup>
							{shared.map((environment) => (
								<SettingsItem
									actions={
										<Button
											disabled={busy}
											onClick={async () => {
												setBusy(true);
												setError(null);
												try {
													setSnapshot(
														await importSharedCloudEnvironment(
															target,
															environment.id,
															snapshot.revision
														)
													);
												} catch (failure) {
													setError(errorMessage(failure));
												} finally {
													setBusy(false);
												}
											}}
											size="sm"
											variant="outline"
										>
											Import template
										</Button>
									}
									key={environment.id}
									title={environment.name}
								/>
							))}
						</SettingsGroup>
					) : null}
					{shared?.length === 0 ? (
						<SettingsCard>
							<p className="text-center text-muted-foreground text-sm">
								No shared templates available.
							</p>
						</SettingsCard>
					) : null}
				</SettingsSection>
			) : null}

			{editing && snapshot ? (
				<EnvironmentDialog
					busy={busy}
					environment={editing}
					environments={snapshot.environments}
					error={error}
					onChange={setEditing}
					onClose={() => setEditing(null)}
					onSave={saveEnvironment}
					vault={snapshot.vault}
				/>
			) : null}

			{vaultOpen && snapshot ? (
				<VaultDialog
					busy={busy}
					environments={snapshot.environments}
					error={error}
					initial={editingVault}
					onClose={() => {
						setVaultOpen(false);
						setEditingVault(null);
					}}
					onSave={async (entries) => {
						const keys = new Set(entries.map((item) => item.key));
						if (
							await save({
								...snapshot,
								vault: [
									...snapshot.vault.filter((item) => !keys.has(item.key)),
									...entries,
								],
							})
						) {
							setVaultOpen(false);
							setEditingVault(null);
						}
					}}
				/>
			) : null}

			{importOpen && snapshot ? (
				<ImportDialog
					busy={busy}
					environments={snapshot.environments}
					onClose={() => setImportOpen(false)}
					onImport={async (keys, kind, environmentIds) => {
						setBusy(true);
						setError(null);
						try {
							if (isLocalCloudVariableImport()) {
								const pairs =
									await invokeCloudEnvironmentSelectedVariables(keys);
								const imported = pairs.map((pair) => ({
									id:
										snapshot.vault.find((entry) => entry.key === pair.key)
											?.id ?? crypto.randomUUID(),
									key: pair.key,
									value: pair.value,
									kind,
									environmentIds,
									domains: [],
								}));
								const keySet = new Set(keys);
								setSnapshot(
									await saveCloudEnvironments(target, {
										...snapshot,
										vault: [
											...snapshot.vault.filter(
												(entry) => !keySet.has(entry.key)
											),
											...imported,
										],
									})
								);
							} else {
								setSnapshot(
									await importCloudVariables(target, {
										keys,
										kind,
										environmentIds,
										domains: [],
										revision: snapshot.revision,
									})
								);
							}
							setImportOpen(false);
						} catch (failure) {
							setError(errorMessage(failure));
						} finally {
							setBusy(false);
						}
					}}
					saveError={error}
					target={target}
				/>
			) : null}

			<Dialog
				onOpenChange={(open) => {
					if (!(open || busy)) {
						setDeleting(null);
					}
				}}
				open={deleting !== null}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete vault entry</DialogTitle>
						<DialogDescription>
							Delete {deleting?.key}? Environments that request this key will no
							longer receive its value.
						</DialogDescription>
					</DialogHeader>
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							disabled={busy}
							onClick={() => setDeleting(null)}
							variant="ghost"
						>
							Cancel
						</Button>
						<Button
							disabled={busy}
							onClick={async () => {
								if (
									snapshot &&
									deleting &&
									(await save({
										...snapshot,
										vault: snapshot.vault.filter(
											(item) => item.id !== deleting.id
										),
									}))
								) {
									setDeleting(null);
								}
							}}
							variant="destructive"
						>
							Delete
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setResult(null);
					}
				}}
				open={result !== null}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Cloud environment setup result</DialogTitle>
						<DialogDescription>
							Setup output is redacted by the node. This checks repository setup
							in a temporary container, then discards it. It does not start an
							agent task.
						</DialogDescription>
					</DialogHeader>
					<pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs">
						{result}
					</pre>
					<DialogFooter>
						<Button onClick={() => setResult(null)}>Close</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function EnvironmentDialog({
	error,
	environment,
	vault,
	environments,
	busy,
	onChange,
	onClose,
	onSave,
}: {
	error: string | null;
	environment: CloudEnvironment;
	vault: CloudVaultEntry[];
	environments: CloudEnvironment[];
	busy: boolean;
	onChange: (value: CloudEnvironment) => void;
	onClose: () => void;
	onSave: (
		value: CloudEnvironment,
		entries: CloudVaultEntryWrite[]
	) => Promise<void>;
}) {
	const [pendingEntries, setPendingEntries] = useState<CloudVaultEntryWrite[]>(
		[]
	);
	const [manageKind, setManageKind] = useState<CloudVaultKind | null>(null);
	const [editingEntry, setEditingEntry] = useState<CloudVaultEntry | null>(
		null
	);
	const [vpnOpen, setVpnOpen] = useState(false);
	const pendingKeys = new Set(pendingEntries.map((entry) => entry.key));
	const availableVault = [
		...vault.filter((entry) => !pendingKeys.has(entry.key)),
		...pendingEntries.map((entry) => ({ ...entry, hasValue: true })),
	];
	const vpnKeys = new Set(
		environments.map((item) => item.tailscaleVaultKey).filter(Boolean)
	);
	if (environment.tailscaleVaultKey) {
		vpnKeys.add(environment.tailscaleVaultKey);
	}
	const stageEntries = async (entries: CloudVaultEntryWrite[]) => {
		const keys = new Set(entries.map((entry) => entry.key));
		setPendingEntries((current) => [
			...current.filter((entry) => !keys.has(entry.key)),
			...entries.map((entry) => {
				const pendingValue = current.find(
					(pending) => pending.key === entry.key
				)?.value;
				return entry.value === undefined && pendingValue !== undefined
					? { ...entry, value: pendingValue }
					: entry;
			}),
		]);
		update({
			vaultKeys: [
				...new Set([
					...environment.vaultKeys.filter((key) => !keys.has(key)),
					...entries
						.filter(
							(entry) =>
								!entry.environmentIds.length ||
								entry.environmentIds.includes(environment.id)
						)
						.map((entry) => entry.key),
				]),
			],
		});
		setManageKind(null);
		setEditingEntry(null);
	};
	const [repositoriesText, setRepositoriesText] = useState(
		environment.repositories.join("\n")
	);
	const [domainsText, setDomainsText] = useState(
		environment.internet.allowedDomains.join("\n")
	);
	const update = (change: Partial<CloudEnvironment>) =>
		onChange({ ...environment, ...change });
	const runtime = environment.runtime ?? DEFAULT_CLOUD_ENVIRONMENT_RUNTIME;
	const updateRuntime = (change: Partial<CloudEnvironmentRuntime>) =>
		update({ runtime: { ...runtime, ...change } });
	const runtimeIssue = cloudEnvironmentRuntimeIssue(
		environment,
		availableVault
	);
	// Fresh cloud box rollout gate (UI-only). Core cannot read per-user flags; the
	// node's Box configuration stays the hard gate for prepare/launch.
	const boxBackendEnabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const boxPreviewBlocked = !boxBackendEnabled && runtime.backend === "box";
	const saveBlocked =
		busy ||
		!environment.name.trim() ||
		Boolean(runtimeIssue) ||
		boxPreviewBlocked;

	return (
		<>
			<Dialog
				onOpenChange={(open) => {
					if (!(open || busy)) {
						onClose();
					}
				}}
				open
			>
				<DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
					<DialogHeader className="shrink-0" purpose="cloud-settings">
						<DialogTitle>Edit cloud environment</DialogTitle>
						<DialogDescription>
							Save a draft while configuring it. Publish when the environment is
							ready for setup.
						</DialogDescription>
						{error ? (
							<p className="text-sm text-status-destructive" role="alert">
								{error}
							</p>
						) : null}
					</DialogHeader>

					<div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
						<div className="space-y-2">
							<Label htmlFor="cloud-name">Name</Label>
							<Input
								id="cloud-name"
								onChange={(event) => update({ name: event.target.value })}
								value={environment.name}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="cloud-repos">Repositories</Label>
							<Textarea
								id="cloud-repos"
								onChange={(event) => {
									setRepositoriesText(event.target.value);
									update({ repositories: lines(event.target.value) });
								}}
								placeholder="owner/repository"
								value={repositoriesText}
							/>
							<p className="text-muted-foreground text-xs">
								One owner/repository name or HTTPS GitHub URL per line.
							</p>
						</div>

						<div className="space-y-2">
							<Label htmlFor="cloud-install">Install script</Label>
							<Textarea
								className="min-h-28"
								id="cloud-install"
								onChange={(event) =>
									update({ installScript: event.target.value })
								}
								placeholder="#!/usr/bin/env bash"
								value={environment.installScript}
								variant="code-caption"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="cloud-start">Start instructions</Label>
							<Textarea
								id="cloud-start"
								onChange={(event) =>
									update({ startInstructions: event.target.value })
								}
								placeholder="Instructions for tasks using this environment"
								value={environment.startInstructions}
							/>
						</div>

						<SettingsSection
							caption="Choose which destinations this environment can access."
							title="Internet access"
						>
							<SettingsGroup>
								<SettingsItem
									actions={
										<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
											<Switch
												aria-label="Allow internet access"
												checked={environment.internet.enabled}
												onCheckedChange={(enabled) =>
													update({
														internet: { ...environment.internet, enabled },
													})
												}
											/>
										</div>
									}
									title="Allow internet access"
								/>
								<SettingsItem
									actions={
										<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
											<NativeSelect
												aria-label="Allowed domain policy"
												disabled={!environment.internet.enabled}
												onChange={(event) => {
													const domainPolicy = event.target.value;
													if (
														domainPolicy === "all" ||
														domainPolicy === "packageManagers" ||
														domainPolicy === "custom"
													) {
														update({
															internet: {
																...environment.internet,
																domainPolicy,
															},
														});
													}
												}}
												value={environment.internet.domainPolicy}
											>
												<NativeSelectOption value="all">
													All (unrestricted)
												</NativeSelectOption>
												<NativeSelectOption value="packageManagers">
													Package managers
												</NativeSelectOption>
												<NativeSelectOption value="custom">
													Custom domains only
												</NativeSelectOption>
											</NativeSelect>
										</div>
									}
									title="Allow domains"
								/>
							</SettingsGroup>
						</SettingsSection>

						{environment.internet.enabled &&
						environment.internet.domainPolicy !== "all" ? (
							<div className="space-y-2">
								<Label htmlFor="cloud-domains">
									Additional allowed domains
								</Label>
								<Textarea
									id="cloud-domains"
									onChange={(event) => {
										setDomainsText(event.target.value);
										update({
											internet: {
												...environment.internet,
												allowedDomains: lines(event.target.value),
											},
										});
									}}
									placeholder="api.example.com"
									value={domainsText}
								/>
							</div>
						) : null}

						<SettingsSection
							caption="Choose where tasks run and which agent drives them."
							title="Runtime"
						>
							<div className="space-y-4 px-3">
								<div className="space-y-2">
									<Label htmlFor="cloud-runtime-backend">Backend</Label>
									<NativeSelect
										id="cloud-runtime-backend"
										onChange={(event) => {
											if (event.target.value === "box") {
												if (boxBackendEnabled) {
													updateRuntime({ backend: "box" });
												}
											} else if (event.target.value === "auto") {
												updateRuntime({ backend: "auto", executor: "ryu" });
											}
										}}
										value={runtime.backend}
									>
										<NativeSelectOption value="auto">
											Automatic
										</NativeSelectOption>
										{boxBackendEnabled ? (
											<NativeSelectOption value="box">
												Fresh cloud box
											</NativeSelectOption>
										) : null}
										{boxPreviewBlocked ? (
											<NativeSelectOption disabled value="box">
												Fresh cloud box (preview not enabled)
											</NativeSelectOption>
										) : null}
									</NativeSelect>
									{boxBackendEnabled ? (
										<p className="text-muted-foreground text-xs">
											A new isolated Ryu Box is created for each chat and
											removed when the session ends.
										</p>
									) : null}
									{boxPreviewBlocked ? (
										<p className="text-muted-foreground text-xs" role="status">
											Fresh cloud box is a preview that is not enabled for your
											account. Switch to Automatic to save.
										</p>
									) : null}
								</div>
								{boxBackendEnabled ? (
									<div className="space-y-2">
										<Label htmlFor="cloud-runtime-agent">Agent</Label>
										<NativeSelect
											disabled={runtime.backend !== "box"}
											id="cloud-runtime-agent"
											onChange={(event) => {
												const executor = runtimeExecutor(event.target.value);
												if (executor) {
													updateRuntime({ executor });
												}
											}}
											value={runtime.executor}
										>
											{RUNTIME_AGENT_OPTIONS.map(([value, label]) => (
												<NativeSelectOption key={value} value={value}>
													{label}
												</NativeSelectOption>
											))}
										</NativeSelect>
										{runtime.executor === "ryu" ? null : (
											<p className="text-muted-foreground text-xs">
												Bind the agent's API key (for example ANTHROPIC_API_KEY
												or OPENAI_API_KEY) as a variable. The agent can read it;
												the GitHub token is used only by Ryu to push.
											</p>
										)}
									</div>
								) : null}
								{boxBackendEnabled && runtime.backend === "box" ? (
									<div className="space-y-2">
										<Label htmlFor="cloud-runtime-lifetime">
											Session length (minutes)
										</Label>
										<Input
											id="cloud-runtime-lifetime"
											inputMode="numeric"
											max={CLOUD_ENVIRONMENT_LIFETIME_MINUTES.max}
											min={CLOUD_ENVIRONMENT_LIFETIME_MINUTES.min}
											onChange={(event) =>
												updateRuntime({
													lifetimeMinutes: event.target.valueAsNumber,
												})
											}
											step={1}
											type="number"
											value={
												Number.isNaN(runtime.lifetimeMinutes)
													? ""
													: runtime.lifetimeMinutes
											}
										/>
									</div>
								) : null}
								{runtimeIssue ? (
									<p className="text-sm text-status-destructive" role="alert">
										{runtimeIssue}
									</p>
								) : null}
							</div>
						</SettingsSection>

						{(["networkSecret", "variable"] satisfies CloudVaultKind[]).map(
							(kind) => (
								<SettingsSection
									caption={
										kind === "variable"
											? "Real values are visible to tasks and tools."
											: "Saving a network secret also allows access to its configured domains."
									}
									key={kind}
									title={
										kind === "variable"
											? "Environment variables"
											: "Network secrets"
									}
								>
									<div className="space-y-2 px-3">
										<Button
											onClick={() => {
												setEditingEntry(null);
												setManageKind(kind);
											}}
											size="sm"
											variant="outline"
										>
											Manage {kind === "variable" ? "variables" : "secrets"}
										</Button>
										{availableVault
											.filter(
												(entry) =>
													entry.kind === kind &&
													!vpnKeys.has(entry.key) &&
													(!entry.environmentIds.length ||
														entry.environmentIds.includes(environment.id))
											)
											.map((entry) => (
												<div
													className="flex items-center justify-between gap-2"
													key={entry.id}
												>
													<Label className="min-w-0">
														<Checkbox
															checked={environment.vaultKeys.includes(
																entry.key
															)}
															onCheckedChange={(checked) =>
																update({
																	vaultKeys: checked
																		? [...environment.vaultKeys, entry.key]
																		: environment.vaultKeys.filter(
																				(key) => key !== entry.key
																			),
																})
															}
														/>
														<span className="break-all">{entry.key}</span>
													</Label>
													<Button
														aria-label={`Edit ${entry.key}`}
														onClick={() => {
															setEditingEntry(entry);
															setManageKind(kind);
														}}
														size="sm"
														variant="ghost"
													>
														Edit
													</Button>
												</div>
											))}
										{availableVault.some(
											(entry) =>
												entry.kind === kind &&
												!vpnKeys.has(entry.key) &&
												(!entry.environmentIds.length ||
													entry.environmentIds.includes(environment.id))
										) ? null : (
											<p className="text-muted-foreground text-sm">
												No{" "}
												{kind === "variable"
													? "environment variables"
													: "network secrets"}{" "}
												added.
											</p>
										)}
									</div>
								</SettingsSection>
							)
						)}

						<SettingsSection title="Privacy">
							<SettingsGroup>
								<SettingsItem
									actions={
										<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
											<NativeSelect
												aria-label="Environment sharing"
												onChange={(event) =>
													update({
														privacy:
															event.target.value === "shared"
																? "shared"
																: "private",
													})
												}
												value={environment.privacy}
											>
												<NativeSelectOption value="private">
													Only me
												</NativeSelectOption>
												<NativeSelectOption value="shared">
													Shared on this node
												</NativeSelectOption>
											</NativeSelect>
										</div>
									}
									title="Who can use"
								/>
							</SettingsGroup>
						</SettingsSection>

						<SettingsSection title="Advanced">
							<SettingsGroup>
								<SettingsItem
									actions={
										<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
											<Button
												onClick={() => setVpnOpen(true)}
												size="sm"
												variant="outline"
											>
												{environment.tailscaleVaultKey
													? "Edit VPN key"
													: "Set VPN key"}
											</Button>
											<NativeSelect
												aria-label="Tailscale vault key"
												onChange={(event) =>
													update({
														tailscaleVaultKey: event.target.value || null,
														vaultKeys: environment.vaultKeys.filter(
															(key) => key !== event.target.value
														),
													})
												}
												value={environment.tailscaleVaultKey ?? ""}
											>
												<NativeSelectOption value="">
													Not set
												</NativeSelectOption>
												{availableVault
													.filter(
														(entry) =>
															(!entry.environmentIds.length ||
																entry.environmentIds.includes(
																	environment.id
																)) &&
															!environments.some(
																(item) =>
																	item.id !== environment.id &&
																	item.vaultKeys.includes(entry.key)
															)
													)
													.map((entry) => (
														<NativeSelectOption
															key={entry.id}
															value={entry.key}
														>
															{entry.key}
														</NativeSelectOption>
													))}
											</NativeSelect>
										</div>
									}
									description="Select a vault key containing an ephemeral, tagged, short-expiry Tailscale auth key. Saving does not test a connection."
									title="Tailscale VPN"
								/>
							</SettingsGroup>
						</SettingsSection>

						<p className="text-muted-foreground text-xs">
							{pendingEntries.length
								? "Credential changes are pending. Save draft or Publish to save them with this environment. "
								: null}
							Domain restrictions, network secrets, and VPN access require a
							cloud runtime that supports them. Run a setup check to verify
							these settings before starting a task.
						</p>
					</div>
					<DialogFooter className="shrink-0" purpose="cloud-actions">
						<Button disabled={busy} onClick={onClose} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={saveBlocked}
							onClick={() =>
								onSave({ ...environment, published: false }, pendingEntries)
							}
							variant="outline"
						>
							Save draft
						</Button>
						<Button
							disabled={saveBlocked}
							onClick={() =>
								onSave({ ...environment, published: true }, pendingEntries)
							}
						>
							{busy ? "Saving…" : "Publish"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{manageKind ? (
				<VaultDialog
					busy={busy}
					environments={
						environments.some((item) => item.id === environment.id)
							? environments
							: [...environments, environment]
					}
					error={null}
					initial={editingEntry}
					initialEnvironmentIds={[environment.id]}
					initialKind={manageKind}
					onClose={() => {
						setManageKind(null);
						setEditingEntry(null);
					}}
					onSave={stageEntries}
					saveDescription="Only your tasks can use these values. Changes are saved with Save draft or Publish in the environment editor. Cancelling the environment discards them."
				/>
			) : null}
			{vpnOpen ? (
				<VpnDialog
					busy={busy}
					hasSavedKey={Boolean(environment.tailscaleVaultKey)}
					onClose={() => setVpnOpen(false)}
					onSave={(value) => {
						const key = `CLOUD_VPN_${environment.id.replaceAll("-", "_")}`;
						const existing = availableVault.find((entry) => entry.key === key);
						setPendingEntries((current) => [
							...current.filter((entry) => entry.key !== key),
							{
								id: existing?.id ?? crypto.randomUUID(),
								key,
								value,
								kind: "variable",
								environmentIds: [environment.id],
								domains: [],
							},
						]);
						update({
							tailscaleVaultKey: key,
							vaultKeys: environment.vaultKeys.filter((entry) => entry !== key),
						});
						setVpnOpen(false);
					}}
				/>
			) : null}
		</>
	);
}

function VaultDialog({
	initial,
	initialKind = "variable",
	initialEnvironmentIds = [],
	saveDescription,
	error: saveError,
	environments,
	busy,
	onClose,
	onSave,
}: {
	initial: CloudVaultEntry | null;
	initialKind?: CloudVaultKind;
	initialEnvironmentIds?: string[];
	saveDescription?: string;
	error: string | null;
	environments: CloudEnvironment[];
	busy: boolean;
	onClose: () => void;
	onSave: (entries: CloudVaultEntryWrite[]) => Promise<void>;
}) {
	const [key, setKey] = useState(initial?.key ?? "");
	const [value, setValue] = useState("");
	const [kind, setKind] = useState<CloudVaultKind>(
		initial?.kind ?? initialKind
	);
	const [scope, setScope] = useState(
		initial?.environmentIds ?? initialEnvironmentIds
	);
	const [domains, setDomains] = useState(initial?.domains.join(", ") ?? "");
	const [paste, setPaste] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		setError(null);
		try {
			if (initial && kind !== initial.kind && !value && !paste) {
				throw new Error(
					"Enter a replacement value when changing the entry type"
				);
			}
			const pairs = parseEnvironmentPaste(paste || `${key}=${value}`);
			if (!pairs.length) {
				throw new Error("Enter a key and value");
			}
			await onSave(
				pairs.map((pair) => ({
					id: initial?.key === pair.key ? initial.id : crypto.randomUUID(),
					key: pair.key,
					...(initial && !value && !paste ? undefined : { value: pair.value }),
					kind,
					environmentIds: scope,
					domains: lines(domains),
					hasValue: true,
				}))
			);
		} catch (failure) {
			setError(errorMessage(failure));
		}
	};

	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{initial ? "Edit personal vault entry" : "Add to personal vault"}
					</DialogTitle>
					<DialogDescription>
						{saveDescription ??
							"Only your tasks can use these values where an environment requests their keys. Saved values stay hidden."}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<KindSelect kind={kind} onChange={setKind} />
					<div className="space-y-2">
						<Label htmlFor="vault-key">Key</Label>
						<Input
							disabled={initial !== null}
							id="vault-key"
							onChange={(event) => setKey(event.target.value)}
							value={key}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="vault-value">Value</Label>
						<Input
							autoComplete="off"
							id="vault-value"
							onChange={(event) => setValue(event.target.value)}
							placeholder={
								initial ? "Leave blank to keep saved value" : undefined
							}
							type="password"
							value={value}
						/>
					</div>
					<VaultEnvironmentScope
						environments={environments}
						onChange={setScope}
						value={scope}
					/>
					{kind === "networkSecret" ? (
						<div className="space-y-2">
							<Label htmlFor="vault-domains">Allowed domains</Label>
							<Input
								id="vault-domains"
								onChange={(event) => setDomains(event.target.value)}
								placeholder="api.example.com"
								value={domains}
							/>
						</div>
					) : null}
					<details>
						<summary className="cursor-pointer text-sm">
							Paste .env entries
						</summary>
						<Textarea
							aria-label="Paste .env entries"
							className="mt-2 [-webkit-text-security:disc]"
							onChange={(event) => setPaste(event.target.value)}
							placeholder="KEY=value"
							typography="caption"
							value={paste}
							variant="code"
						/>
					</details>
					{error || saveError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error ?? saveError}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={busy || !(key.trim() || paste.trim())}
						onClick={submit}
					>
						{busy ? "Saving…" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function VpnDialog({
	hasSavedKey,
	busy,
	onClose,
	onSave,
}: {
	hasSavedKey: boolean;
	busy: boolean;
	onClose: () => void;
	onSave: (value: string) => void;
}) {
	const [value, setValue] = useState("");
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Tailscale VPN</DialogTitle>
					<DialogDescription>
						Use an ephemeral, tagged, short-expiry Tailscale auth key. Saving
						does not test the connection. The key is saved with the environment
						and stays hidden after saving.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="cloud-vpn-auth-key">Tailscale auth key</Label>
					<Input
						autoComplete="off"
						id="cloud-vpn-auth-key"
						onChange={(event) => setValue(event.target.value)}
						placeholder={hasSavedKey ? "Enter a replacement key" : undefined}
						type="password"
						value={value}
					/>
					<p className="text-muted-foreground text-xs">
						For restricted internet policies, add private IPv4 addresses or
						ordinary DNS hostnames that resolve to IPv4 under Additional allowed
						domains. Tailscale MagicDNS and IPv6 are not supported.
					</p>
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={busy || !value.trim()}
						onClick={() => onSave(value.trim())}
					>
						Save VPN key
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function VaultEnvironmentScope({
	environments,
	value,
	onChange,
}: {
	environments: CloudEnvironment[];
	value: string[];
	onChange: (value: string[]) => void;
}) {
	return (
		<fieldset className="space-y-2">
			<legend className="font-medium text-sm">Applies to</legend>
			<Label>
				<Checkbox
					checked={value.length === 0}
					onCheckedChange={(checked) =>
						onChange(checked ? [] : environments[0] ? [environments[0].id] : [])
					}
				/>
				All environments
			</Label>
			<div className="max-h-36 space-y-2 overflow-y-auto">
				{environments.map((environment) => (
					<Label key={environment.id}>
						<Checkbox
							checked={value.includes(environment.id)}
							onCheckedChange={(checked) =>
								onChange(
									checked
										? [...value, environment.id]
										: value.length === 1
											? value
											: value.filter((id) => id !== environment.id)
								)
							}
						/>
						{environment.name}
					</Label>
				))}
			</div>
			<p className="text-muted-foreground text-xs">
				Select one or more environments, or choose All environments.
			</p>
		</fieldset>
	);
}

function KindSelect({
	kind,
	onChange,
}: {
	kind: CloudVaultKind;
	onChange: (value: CloudVaultKind) => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="vault-kind">Type</Label>
			<NativeSelect
				id="vault-kind"
				onChange={(event) =>
					onChange(
						event.target.value === "networkSecret"
							? "networkSecret"
							: "variable"
					)
				}
				value={kind}
			>
				<NativeSelectOption value="variable">
					Environment variable
				</NativeSelectOption>
				<NativeSelectOption value="networkSecret">
					Network secret
				</NativeSelectOption>
			</NativeSelect>
			<p className="text-muted-foreground text-xs">
				{kind === "variable"
					? "Real value inside the environment, visible to tasks and tools."
					: "Hidden value, replaced in outgoing requests by a supported proxy."}
			</p>
		</div>
	);
}

function EnvironmentScope({
	environments,
	value,
	onChange,
}: {
	environments: CloudEnvironment[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor="vault-scope">Applies to</Label>
			<NativeSelect
				id="vault-scope"
				onChange={(event) => onChange(event.target.value)}
				value={value}
			>
				<NativeSelectOption value="">All environments</NativeSelectOption>
				{environments.map((item) => (
					<NativeSelectOption key={item.id} value={item.id}>
						{item.name}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</div>
	);
}

function ImportDialog({
	saveError,
	target,
	environments,
	busy,
	onClose,
	onImport,
}: {
	saveError: string | null;
	target: ApiTarget;
	environments: CloudEnvironment[];
	busy: boolean;
	onClose: () => void;
	onImport: (
		keys: string[],
		kind: CloudVaultKind,
		environmentIds: string[]
	) => Promise<void>;
}) {
	const [names, setNames] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [search, setSearch] = useState("");
	const [kind, setKind] = useState<CloudVaultKind>("variable");
	const [scope, setScope] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		fetchImportVariableNames({
			url: target.url,
			token: target.token,
			userJwt: target.userJwt,
		})
			.then((values) => {
				if (active) {
					setNames(values);
				}
			})
			.catch((failure) => {
				if (active) {
					setError(errorMessage(failure));
				}
			});
		return () => {
			active = false;
		};
	}, [target.url, target.token, target.userJwt]);

	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					onClose();
				}
			}}
			open
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{isLocalCloudVariableImport()
							? "Import local variables"
							: "Import node variables"}
					</DialogTitle>
					<DialogDescription>
						{isLocalCloudVariableImport()
							? "Choose up to 100 variables from this computer's shell environment."
							: "Choose up to 100 variables from the selected node's process environment. Node owner access is required."}{" "}
						Reserved variables are excluded. Values stay hidden and only
						selected values are saved.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<KindSelect kind={kind} onChange={setKind} />
					<Input
						aria-label="Search variable names"
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search variable names"
						value={search}
					/>
					<div className="max-h-60 space-y-3 overflow-y-auto">
						{names ? (
							names
								.filter((name) =>
									name.toLowerCase().includes(search.toLowerCase())
								)
								.map((name) => (
									<Label
										className="justify-between"
										key={name}
										spacing="field-row"
									>
										<span className="break-all font-mono text-xs">{name}</span>
										<Checkbox
											checked={selected.includes(name)}
											disabled={
												!selected.includes(name) && selected.length >= 100
											}
											onCheckedChange={(checked) =>
												setSelected((current) =>
													checked
														? [...current, name]
														: current.filter((item) => item !== name)
												)
											}
										/>
									</Label>
								))
						) : error ? null : (
							<p role="status">Loading variable names…</p>
						)}
					</div>
					<p className="text-muted-foreground text-xs">
						{selected.length} variables selected
					</p>
					<EnvironmentScope
						environments={environments}
						onChange={setScope}
						value={scope}
					/>
					{error || saveError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error ?? saveError}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button disabled={busy} onClick={onClose} variant="ghost">
						Close
					</Button>
					<Button
						disabled={busy || !selected.length}
						onClick={() => onImport(selected, kind, scope ? [scope] : [])}
					>
						{busy ? "Importing…" : "Import selected"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

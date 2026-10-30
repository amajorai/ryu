import { Button } from "@ryu/ui/components/button.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { SubscriptionBackendsSettings } from "@/src/components/gateway/SubscriptionBackendsSettings.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";

import type { ApiTarget } from "@/src/lib/api/client.ts";

import {
	type CloudEnvironment,
	type CloudEnvironmentsSnapshot,
	type CloudEnvironmentWrite,
	type CloudVaultEntry,
	type CloudVaultEntryWrite,
	type CloudVaultKind,
	fetchCloudEnvironments,
	importCloudVariables,
	invokeCloudEnvironmentSelectedVariables,
	isLocalCloudVariableImport,
	runCloudEnvironmentSetup,
	saveCloudEnvironments,
} from "@/src/lib/api/cloud-environments.ts";
import { EnvironmentDialog } from "./CloudEnvironmentsSettings-environment-dialog.tsx";
import { ImportDialog } from "./CloudEnvironmentsSettings-import-dialog.tsx";
import {
	CloudEnvironmentsFilters,
	CloudEnvironmentsList,
	DeleteVaultEntryDialog,
	SetupResultDialog,
	SharedTemplatesSection,
} from "./CloudEnvironmentsSettings-panels.tsx";
import {
	createEnvironment,
	errorMessage,
	paneErrorHeadline,
} from "./CloudEnvironmentsSettings-shared.ts";
import { VaultDialog } from "./CloudEnvironmentsSettings-vault-dialogs.tsx";
import { SettingsNotice } from "./SettingsNotice.tsx";

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
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={"Personal vault values stay hidden after saving."}
					>
						{"Repository setup, instructions, network access and credentials."}
					</CaptionInfo>
				}
				headerAction={
					tab === "environments" ? (
						<Button
							disabled={!snapshot || busy}
							onClick={() => {
								setError(null);
								setEditing(createEnvironment());
							}}
							size="sm"
							variant="outline"
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
								variant="outline"
							>
								Add
							</Button>
						</div>
					)
				}
				title="Cloud environments"
			>
				<CloudEnvironmentsFilters
					search={search}
					setSearch={setSearch}
					setTab={setTab}
					setVaultFilter={setVaultFilter}
					tab={tab}
					vaultFilter={vaultFilter}
				/>

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

				<CloudEnvironmentsList
					busy={busy}
					matchingEnvironments={matchingEnvironments}
					matchingVault={matchingVault}
					runSetup={runSetup}
					setDeleting={setDeleting}
					setEditing={setEditing}
					setEditingVault={setEditingVault}
					setError={setError}
					setVaultOpen={setVaultOpen}
					snapshot={snapshot}
					tab={tab}
					tabEntries={tabEntries}
					tabMatches={tabMatches}
				/>
			</SettingsSection>

			<SubscriptionBackendsSettings
				environments={(snapshot?.environments ?? [])
					.filter((environment) => environment.published)
					.map(({ id, name }) => ({ id, name }))}
				target={target}
			/>

			{snapshot ? (
				<SharedTemplatesSection
					busy={busy}
					setBusy={setBusy}
					setError={setError}
					setShared={setShared}
					setSnapshot={setSnapshot}
					shared={shared}
					snapshot={snapshot}
					target={target}
				/>
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

			<DeleteVaultEntryDialog
				busy={busy}
				deleting={deleting}
				error={error}
				save={save}
				setDeleting={setDeleting}
				snapshot={snapshot}
			/>

			<SetupResultDialog result={result} setResult={setResult} />
		</div>
	);
}

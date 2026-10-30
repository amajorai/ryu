import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
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
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type CloudEnvironmentRuntime,
	cloudEnvironmentRuntimeIssue,
	DEFAULT_CLOUD_ENVIRONMENT_RUNTIME,
} from "@ryuhq/protocol/cloud-environments";
import { useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type {
	CloudEnvironment,
	CloudVaultEntry,
	CloudVaultEntryWrite,
	CloudVaultKind,
} from "@/src/lib/api/cloud-environments.ts";
import {
	EnvironmentAccessSections,
	EnvironmentRuntimeSection,
	EnvironmentVaultSections,
} from "./CloudEnvironmentsSettings-environment-sections.tsx";
import { lines } from "./CloudEnvironmentsSettings-shared.ts";
import {
	VaultDialog,
	VpnDialog,
} from "./CloudEnvironmentsSettings-vault-dialogs.tsx";

export function EnvironmentDialog({
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
	const tl = useLiteralMessages();
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

					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
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

						<EnvironmentRuntimeSection
							boxBackendEnabled={boxBackendEnabled}
							boxPreviewBlocked={boxPreviewBlocked}
							runtime={runtime}
							runtimeIssue={runtimeIssue}
							updateRuntime={updateRuntime}
						/>

						<EnvironmentVaultSections
							availableVault={availableVault}
							environment={environment}
							setEditingEntry={setEditingEntry}
							setManageKind={setManageKind}
							update={update}
							vpnKeys={vpnKeys}
						/>

						<EnvironmentAccessSections
							availableVault={availableVault}
							environment={environment}
							environments={environments}
							setVpnOpen={setVpnOpen}
							update={update}
						/>

						<p className="text-muted-foreground text-xs">
							{pendingEntries.length
								? `${tl("Credential changes are pending. Save draft or Publish to save them with this environment.")} `
								: null}
							{tl(
								"Domain restrictions, network secrets, and VPN access require a cloud runtime that supports them. Run a setup check to verify these settings before starting a task."
							)}
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
							variant="outline"
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

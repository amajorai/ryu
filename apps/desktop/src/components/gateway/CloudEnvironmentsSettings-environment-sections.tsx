import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	CLOUD_ENVIRONMENT_LIFETIME_MINUTES,
	type CloudEnvironmentRuntime,
} from "@ryuhq/protocol/cloud-environments";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	CloudEnvironment,
	CloudVaultEntry,
	CloudVaultKind,
} from "@/src/lib/api/cloud-environments.ts";
import {
	RUNTIME_AGENT_OPTIONS,
	runtimeExecutor,
} from "./CloudEnvironmentsSettings-shared.ts";

export function EnvironmentRuntimeSection({
	runtime,
	updateRuntime,
	boxBackendEnabled,
	boxPreviewBlocked,
	runtimeIssue,
}: {
	runtime: CloudEnvironmentRuntime;
	updateRuntime: (change: Partial<CloudEnvironmentRuntime>) => void;
	boxBackendEnabled: boolean;
	boxPreviewBlocked: boolean;
	runtimeIssue: string | null;
}) {
	return (
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
						<NativeSelectOption value="auto">Automatic</NativeSelectOption>
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
							A new isolated Ryu Box is created for each chat and removed when
							the session ends.
						</p>
					) : null}
					{boxPreviewBlocked ? (
						<p className="text-muted-foreground text-xs" role="status">
							Fresh cloud box is a preview that is not enabled for your account.
							Switch to Automatic to save.
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
								Bind the agent's API key (for example ANTHROPIC_API_KEY or
								OPENAI_API_KEY) as a variable. The agent can read it; the GitHub
								token is used only by Ryu to push.
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
	);
}

export function EnvironmentVaultSections({
	availableVault,
	vpnKeys,
	environment,
	update,
	setEditingEntry,
	setManageKind,
}: {
	availableVault: CloudVaultEntry[];
	vpnKeys: Set<string | null>;
	environment: CloudEnvironment;
	update: (change: Partial<CloudEnvironment>) => void;
	setEditingEntry: (entry: CloudVaultEntry | null) => void;
	setManageKind: (kind: CloudVaultKind | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
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
							kind === "variable" ? "Environment variables" : "Network secrets"
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
								{kind === "variable"
									? tl("Manage variables")
									: tl("Manage secrets")}
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
												checked={environment.vaultKeys.includes(entry.key)}
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
											aria-label={tl("Edit {key}", { key: entry.key })}
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
									{kind === "variable"
										? tl("No environment variables added.")
										: tl("No network secrets added.")}
								</p>
							)}
						</div>
					</SettingsSection>
				)
			)}
		</>
	);
}

export function EnvironmentAccessSections({
	availableVault,
	environment,
	environments,
	update,
	setVpnOpen,
}: {
	availableVault: CloudVaultEntry[];
	environment: CloudEnvironment;
	environments: CloudEnvironment[];
	update: (change: Partial<CloudEnvironment>) => void;
	setVpnOpen: (open: boolean) => void;
}) {
	return (
		<>
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
												event.target.value === "shared" ? "shared" : "private",
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
									<NativeSelectOption value="">Not set</NativeSelectOption>
									{availableVault
										.filter(
											(entry) =>
												(!entry.environmentIds.length ||
													entry.environmentIds.includes(environment.id)) &&
												!environments.some(
													(item) =>
														item.id !== environment.id &&
														item.vaultKeys.includes(entry.key)
												)
										)
										.map((entry) => (
											<NativeSelectOption key={entry.id} value={entry.key}>
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
		</>
	);
}

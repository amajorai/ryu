import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudSpeechAccounts,
	type CloudSpeechEdit,
	type CloudSpeechPolicy,
	editCloudSpeechAccounts,
	getCloudSpeechAccounts,
} from "@/src/lib/api/cloud-speech-accounts.ts";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";
import {
	fetchGatewaySpeechSettings,
	type GatewaySpeechSettings as SpeechSettings,
	saveGatewayAnonymousSpeech,
} from "@/src/lib/api/speech-settings.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

function CloudSpeechAccountRow({
	accountId,
	label,
	policy,
	disabled,
	onConfigure,
	onRemove,
}: {
	accountId: string;
	label: string;
	policy: CloudSpeechPolicy;
	disabled: boolean;
	onConfigure: (policy: CloudSpeechPolicy) => Promise<boolean>;
	onRemove: () => Promise<boolean>;
}) {
	const incoming = {
		...policy,
		name: policy.name || `Account ${accountId.slice(0, 8)}`,
	};
	const [draft, setDraft] = useState(incoming);
	const [expanded, setExpanded] = useState(false);
	const previous = useRef(incoming);
	useEffect(() => {
		const next = {
			...policy,
			name: policy.name || `Account ${accountId.slice(0, 8)}`,
		};
		const old = previous.current;
		setDraft((current) => ({
			name: current.name === old.name ? next.name : current.name,
			enabled: current.enabled === old.enabled ? next.enabled : current.enabled,
			priority:
				current.priority === old.priority ? next.priority : current.priority,
		}));
		previous.current = next;
	}, [accountId, policy]);
	const changed =
		draft.name !== incoming.name ||
		draft.enabled !== incoming.enabled ||
		draft.priority !== incoming.priority;
	const valid =
		draft.name.trim().length > 0 &&
		draft.name.length <= 80 &&
		Number.isInteger(draft.priority) &&
		draft.priority >= 0 &&
		draft.priority <= 65_535;
	return (
		<div className="space-y-2 px-3.5 py-2.5 text-sm">
			<div className="flex items-center justify-between gap-3">
				<span>
					{policy.name ? `${policy.name} · ` : ""}
					{label} · {accountId.slice(0, 8)}
					{policy.enabled ? "" : " · Disabled"}
					{policy.priority ? ` · Priority ${policy.priority}` : ""}
				</span>
				<div className="flex gap-2">
					<Button
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
						size="sm"
						variant="ghost"
					>
						Routing
					</Button>
					<Button
						disabled={disabled}
						onClick={() => void onRemove()}
						size="sm"
						variant="outline"
					>
						Remove
					</Button>
				</div>
			</div>
			{expanded ? (
				<div className="grid gap-2 sm:grid-cols-[1fr_7rem_auto_auto] sm:items-end">
					<label className="space-y-1 text-xs">
						Account name
						<Input
							aria-label={`${label} account name`}
							disabled={disabled}
							maxLength={80}
							onChange={(event) =>
								setDraft({ ...draft, name: event.target.value })
							}
							value={draft.name}
						/>
					</label>
					<label className="space-y-1 text-xs">
						Priority
						<Input
							aria-label={`${label} priority`}
							disabled={disabled}
							max={65_535}
							min={0}
							onChange={(event) =>
								setDraft({ ...draft, priority: Number(event.target.value) })
							}
							type="number"
							value={draft.priority}
						/>
					</label>
					<div className="flex items-center gap-2 pb-2 text-xs">
						<Switch
							aria-label={`${label} enabled`}
							checked={draft.enabled}
							disabled={disabled}
							onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
						/>
						Enabled
					</div>
					<Button
						disabled={disabled || !changed || !valid}
						onClick={() =>
							void onConfigure({ ...draft, name: draft.name.trim() }).then(
								(saved) => {
									if (saved) {
										setExpanded(false);
									}
								}
							)
						}
						size="sm"
					>
						Save routing
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function GatewayCloudSpeechAccounts({
	providers,
	target,
	canConfigure,
	canView,
	managed,
	onRefresh,
}: {
	providers: GatewayProvidersConfig | null;
	target: ApiTarget;
	canConfigure: boolean;
	canView: boolean;
	managed: boolean;
	onRefresh: () => Promise<void>;
}) {
	const [view, setView] = useState<CloudSpeechAccounts | null>(null);
	const [provider, setProvider] = useState<"google-tts" | "polly">(
		"google-tts"
	);
	const [token, setToken] = useState("");
	const [project, setProject] = useState("");
	const [region, setRegion] = useState("us-east-1");
	const [keyId, setKeyId] = useState("");
	const [secret, setSecret] = useState("");
	const [session, setSession] = useState("");
	const [expiry, setExpiry] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	useEffect(() => {
		let active = true;
		setView(null);
		setError(null);
		setToken("");
		setProject("");
		setKeyId("");
		setSecret("");
		setSession("");
		setExpiry("");
		if (canView) {
			getCloudSpeechAccounts(target)
				.then((value) => {
					if (active) {
						setView(value);
						setRegion(value?.polly.region ?? "us-east-1");
					}
				})
				.catch((cause) => {
					if (active) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not load speech accounts"
						);
					}
				});
		}
		return () => {
			active = false;
		};
	}, [canView, target]);
	const edit = async (change: CloudSpeechEdit): Promise<boolean> => {
		if (!(view && canConfigure) || managed || busy) {
			return false;
		}
		setBusy(true);
		setSaved(false);
		setError(null);
		try {
			await editCloudSpeechAccounts(target, view.configRevision, change);
			const next = await getCloudSpeechAccounts(target);
			setView(next);
			setRegion(next?.polly.region ?? "us-east-1");
			setToken("");
			setKeyId("");
			setSecret("");
			setSession("");
			await onRefresh();
			setSaved(true);
			return true;
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not edit speech account"
			);
			const next = await getCloudSpeechAccounts(target).catch(() => null);
			if (next) {
				setView(next);
			}
			return false;
		} finally {
			setBusy(false);
		}
	};
	const parsedExpiry = expiry.trim() ? Number(expiry) : undefined;
	const canEdit = Boolean(view && canConfigure && !managed && !busy);
	const rows = [
		providers?.google_tts || view?.googleTts.length
			? {
					context: "Supplied OAuth tokens and quota project",
					count:
						view?.googleTts.length ?? providers?.google_tts?.account_count ?? 0,
					id: "google-tts",
					label: "Google Cloud Text-to-Speech",
				}
			: null,
		providers?.polly || view?.polly.accounts.length
			? {
					context: `Explicit AWS credentials · ${view?.polly.region ?? providers?.polly?.region ?? region}`,
					count:
						view?.polly.accounts.length ?? providers?.polly?.account_count ?? 0,
					id: "polly",
					label: "Amazon Polly",
				}
			: null,
	].filter((row): row is NonNullable<typeof row> => row !== null);
	return (
		<SettingsSection
			caption="Add accounts and control their routing on this node. Secrets stay hidden on readback. Google tokens are supplied and expire; Ryu does not refresh them."
			title="Cloud speech connections"
		>
			<SettingsGroup>
				{rows.map((row) => (
					<SettingsItem
						description={`${row.count} saved ${row.count === 1 ? "account" : "accounts"} · ${row.context}`}
						key={row.id}
						title={
							<span className="flex items-center gap-2">
								<ProviderBrandLogo providerKey={row.id} />
								{row.label}
							</span>
						}
					/>
				))}
			</SettingsGroup>
			{view ? (
				<>
					{view.googleTts.length + view.polly.accounts.length > 0 ? (
						// Saved accounts as rows of one card; each row keeps its own
						// Routing editor below its title.
						<SettingsGroup>
							{view.googleTts.map((account) => (
								<CloudSpeechAccountRow
									accountId={account.accountId}
									disabled={!canEdit}
									key={account.accountId}
									label={`Google · ${account.quotaProject}${account.expiresAtUnixSecs ? ` · expires ${new Date(account.expiresAtUnixSecs * 1000).toLocaleString()}` : ""}`}
									onConfigure={(accountPolicy) =>
										edit({
											action: "configure",
											provider: "google-tts",
											accountId: account.accountId,
											accountPolicy,
										})
									}
									onRemove={() =>
										edit({
											action: "remove",
											provider: "google-tts",
											accountId: account.accountId,
										})
									}
									policy={account.policy}
								/>
							))}
							{view.polly.accounts.map((account) => (
								<CloudSpeechAccountRow
									accountId={account.accountId}
									disabled={!canEdit}
									key={account.accountId}
									label={`Polly · ${account.accessKeyHint}•••• · ${view.polly.region}`}
									onConfigure={(accountPolicy) =>
										edit({
											action: "configure",
											provider: "polly",
											accountId: account.accountId,
											accountPolicy,
										})
									}
									onRemove={() =>
										edit({
											action: "remove",
											provider: "polly",
											accountId: account.accountId,
										})
									}
									policy={account.policy}
								/>
							))}
						</SettingsGroup>
					) : null}
					<SettingsCard className="space-y-3">
						<div
							aria-label="Cloud speech provider"
							className="flex gap-2"
							role="group"
						>
							<Button
								aria-pressed={provider === "google-tts"}
								onClick={() => setProvider("google-tts")}
								size="sm"
								variant={provider === "google-tts" ? "secondary" : "ghost"}
							>
								Google TTS
							</Button>
							<Button
								aria-pressed={provider === "polly"}
								onClick={() => setProvider("polly")}
								size="sm"
								variant={provider === "polly" ? "secondary" : "ghost"}
							>
								Amazon Polly
							</Button>
						</div>
						{provider === "google-tts" ? (
							<div className="grid gap-2 sm:grid-cols-2">
								<label className="space-y-1 text-xs">
									OAuth access token
									<Input
										autoComplete="off"
										onChange={(event) => setToken(event.target.value)}
										type="password"
										value={token}
									/>
								</label>
								<label className="space-y-1 text-xs">
									Quota project
									<Input
										onChange={(event) => setProject(event.target.value)}
										value={project}
									/>
								</label>
							</div>
						) : (
							<div className="grid gap-2 sm:grid-cols-2">
								<label className="space-y-1 text-xs">
									AWS region
									<Input
										disabled={view.polly.accounts.length > 0}
										onChange={(event) => setRegion(event.target.value)}
										value={region}
									/>
								</label>
								<label className="space-y-1 text-xs">
									Access key ID
									<Input
										autoComplete="off"
										onChange={(event) => setKeyId(event.target.value)}
										value={keyId}
									/>
								</label>
								<label className="space-y-1 text-xs">
									Secret access key
									<Input
										autoComplete="off"
										onChange={(event) => setSecret(event.target.value)}
										type="password"
										value={secret}
									/>
								</label>
								<label className="space-y-1 text-xs">
									Session token, optional
									<Input
										autoComplete="off"
										onChange={(event) => setSession(event.target.value)}
										type="password"
										value={session}
									/>
								</label>
							</div>
						)}
						<label className="block max-w-xs space-y-1 text-xs">
							Expiry, Unix seconds, optional
							<Input
								inputMode="numeric"
								onChange={(event) => setExpiry(event.target.value)}
								type="number"
								value={expiry}
							/>
						</label>
						<Button
							disabled={
								!canEdit ||
								(provider === "google-tts"
									? !(token && project)
									: !(keyId && secret && region)) ||
								(parsedExpiry !== undefined &&
									(!Number.isSafeInteger(parsedExpiry) || parsedExpiry < 0))
							}
							onClick={() =>
								void edit(
									provider === "google-tts"
										? {
												action: "add",
												provider,
												accessToken: token,
												quotaProject: project,
												expiresAtUnixSecs: parsedExpiry,
											}
										: {
												action: "add",
												provider,
												region,
												accessKeyId: keyId,
												secretAccessKey: secret,
												sessionToken: session || undefined,
												expiresAtUnixSecs: parsedExpiry,
											}
								)
							}
							size="sm"
						>
							Add {provider === "google-tts" ? "Google" : "Polly"} account
						</Button>
					</SettingsCard>
				</>
			) : null}
			{error ? (
				<p className="px-3.5 text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{saved ? (
				<p className="px-3.5 text-muted-foreground text-xs" role="status">
					Saved and applied to new requests.
				</p>
			) : null}
		</SettingsSection>
	);
}

export function GatewaySpeechSettings({
	target,
	canView,
	canConfigure,
	managed,
	onRefresh,
}: {
	canConfigure: boolean;
	canView: boolean;
	managed: boolean;
	onRefresh: () => Promise<void>;
	target: ApiTarget;
}) {
	const current = useRef(target);
	const [settings, setSettings] = useState<SpeechSettings | null>(null);
	const [enabled, setEnabled] = useState(false);
	const [translateEnabled, setTranslateEnabled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		current.current = target;
		let active = true;
		setSettings(null);
		setEnabled(false);
		setTranslateEnabled(false);
		setBusy(false);
		setError(null);
		setSaved(false);
		if (canView) {
			fetchGatewaySpeechSettings(target)
				.then((value) => {
					if (!active) {
						return;
					}
					setSettings(value);
					setEnabled(value?.edgeTts.anonymousConsumerOptIn ?? false);
					setTranslateEnabled(
						value?.googleTranslateTts?.anonymousConsumerOptIn ?? false
					);
				})
				.catch((cause) => {
					if (active) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not load speech settings"
						);
					}
				});
		}
		return () => {
			active = false;
		};
	}, [target, canView]);

	const save = async () => {
		if (!(settings && canConfigure) || managed || busy) {
			return;
		}
		setBusy(true);
		setSaved(false);
		setError(null);
		try {
			let updated = settings;
			if (enabled !== settings.edgeTts.anonymousConsumerOptIn) {
				await saveGatewayAnonymousSpeech(
					target,
					enabled,
					updated.configRevision
				);
				const refreshed = await fetchGatewaySpeechSettings(target);
				if (!refreshed) {
					throw new Error("Speech settings are no longer available.");
				}
				updated = refreshed;
			}
			if (current.current !== target) {
				return;
			}
			if (
				updated.googleTranslateTts &&
				translateEnabled !== updated.googleTranslateTts.anonymousConsumerOptIn
			) {
				await saveGatewayAnonymousSpeech(
					target,
					translateEnabled,
					updated.configRevision,
					"google-translate-tts"
				);
				const refreshed = await fetchGatewaySpeechSettings(target);
				if (!refreshed) {
					throw new Error("Speech settings are no longer available.");
				}
				updated = refreshed;
			}
			if (current.current !== target) {
				return;
			}
			setSettings(updated);
			setSaved(true);
			await onRefresh();
		} catch (cause) {
			if (current.current !== target) {
				return;
			}
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save speech settings"
			);
			try {
				const updated = await fetchGatewaySpeechSettings(target);
				if (current.current !== target) {
					return;
				}
				setSettings(updated);
				await onRefresh();
			} catch {
				// Preserve the original save explanation and the user's switch draft.
			}
		} finally {
			if (current.current === target) {
				setBusy(false);
			}
		}
	};

	if (!(canView && (settings || error))) {
		return null;
	}
	return (
		<SettingsSection
			caption="These consumer speech services use no provider credential accounts. Enable each service explicitly."
			headerAction={
				<div className="flex items-center gap-1">
					<Button
						disabled={busy}
						onClick={() => {
							void fetchGatewaySpeechSettings(target)
								.then((updated) => {
									if (current.current !== target) {
										return;
									}
									setSettings(updated);
									setEnabled(updated?.edgeTts.anonymousConsumerOptIn ?? false);
									setTranslateEnabled(
										updated?.googleTranslateTts?.anonymousConsumerOptIn ?? false
									);
									setError(null);
									return onRefresh();
								})
								.catch((cause) => {
									if (current.current === target) {
										setError(
											cause instanceof Error
												? cause.message
												: "Could not refresh speech settings"
										);
									}
								});
						}}
						size="sm"
						variant="ghost"
					>
						Refresh speech settings
					</Button>
					<Button
						disabled={
							!(settings && canConfigure) ||
							managed ||
							busy ||
							(enabled === settings.edgeTts.anonymousConsumerOptIn &&
								(!settings.googleTranslateTts ||
									translateEnabled ===
										settings.googleTranslateTts.anonymousConsumerOptIn))
						}
						onClick={() => void save()}
						size="sm"
						variant="ghost"
					>
						Save speech settings
					</Button>
				</div>
			}
			title="Anonymous speech"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Enable anonymous Edge TTS"
							checked={enabled}
							disabled={!(settings && canConfigure) || managed || busy}
							onCheckedChange={(value) => {
								setEnabled(value);
								setSaved(false);
							}}
						/>
					}
					description="Unofficial consumer integration. Use native voice IDs with the edge-tts model."
					title="Edge TTS"
				/>
				{settings?.googleTranslateTts ? (
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable anonymous Google Translate TTS"
								checked={translateEnabled}
								disabled={!canConfigure || managed || busy}
								onCheckedChange={(value) => {
									setTranslateEnabled(value);
									setSaved(false);
								}}
							/>
						}
						description="Unofficial Google Translate service. Use google-translate-tts with a language code and MP3 output. Google Cloud accounts stay separate."
						title="Google Translate TTS"
					/>
				) : null}
			</SettingsGroup>
			{error ? (
				<p className="px-3.5 text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{saved ? (
				<p className="px-3.5 text-muted-foreground text-xs" role="status">
					Saved and applied to new requests.
				</p>
			) : null}
		</SettingsSection>
	);
}

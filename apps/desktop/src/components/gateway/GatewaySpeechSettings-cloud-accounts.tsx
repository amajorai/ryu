import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useState } from "react";
import { CloudSpeechAccountRow } from "@/src/components/gateway/GatewaySpeechSettings-account-row.tsx";
import { CaptionInfo, Segmented } from "@/src/components/gateway/quiet.tsx";
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
	editCloudSpeechAccounts,
	getCloudSpeechAccounts,
} from "@/src/lib/api/cloud-speech-accounts.ts";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";

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
	const tl = useLiteralMessages();
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
			caption={
				<CaptionInfo
					detail={
						"Secrets stay hidden on readback. Google tokens are supplied and expire; Ryu does not refresh them."
					}
				>
					{"Accounts and their routing on this node."}
				</CaptionInfo>
			}
			title="Cloud speech connections"
		>
			<SettingsGroup>
				{rows.map((row) => (
					<SettingsItem
						description={tl(
							"{count, plural, one {# saved account} other {# saved accounts}} · {context}",
							{ count: row.count, context: row.context }
						)}
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
									label={tl("Google · {quotaProject}{expiry}", {
										quotaProject: account.quotaProject,
										expiry: account.expiresAtUnixSecs
											? ` · ${tl("expires {date}", { date: new Date(account.expiresAtUnixSecs * 1000).toLocaleString() })}`
											: "",
									})}
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
									label={tl("Polly · {accessKeyHint}•••• · {region}", {
										accessKeyHint: account.accessKeyHint,
										region: view.polly.region,
									})}
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
						<Segmented
							label="Cloud speech provider"
							onChange={setProvider}
							options={[
								{ label: "Google TTS", value: "google-tts" },
								{ label: "Amazon Polly", value: "polly" },
							]}
							value={provider}
						/>
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
							variant="outline"
						>
							{tl("Add {provider} account", {
								provider: provider === "google-tts" ? "Google" : "Polly",
							})}
						</Button>
					</SettingsCard>
				</>
			) : null}
			{error ? (
				<p className="px-3 text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{saved ? (
				<p className="px-3 text-muted-foreground text-xs" role="status">
					Saved and applied to new requests.
				</p>
			) : null}
		</SettingsSection>
	);
}

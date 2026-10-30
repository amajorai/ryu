import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { ItemSeparator } from "@ryu/ui/components/item.tsx";
import { useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	addGatewayProviderAccount,
	clearGatewayProvider,
	configureGatewayProviderAccount,
	type GatewayProvidersConfig,
	type GatewaySdkContext,
	type GatewaySdkProviderView,
	removeGatewayProviderAccount,
	requireGatewayProviderReload,
	setGatewaySdkConnection,
} from "@/src/lib/api/gateway.ts";
import {
	gatewayAccountErrorMessage,
	ProviderRow,
} from "./GatewayProviderKeyRow.tsx";

function initialContext(provider: GatewaySdkProviderView): GatewaySdkContext {
	if (provider.context && provider.context.kind === provider.context_kind) {
		return provider.context;
	}
	switch (provider.context_kind) {
		case "vertex":
			return { kind: "vertex", project: "", location: "global" };
		case "bedrock_api":
			return { kind: "bedrock_api", region: "us-east-1" };
		case "ollama":
			return { kind: "ollama", base_url: "http://127.0.0.1:11434" };
		default:
			return { kind: "default" };
	}
}

function Connection({
	provider,
	providers,
	target,
	onRefresh,
	readOnly,
	canConfigure,
	expectedRevision,
}: {
	provider: GatewaySdkProviderView;
	providers: GatewayProvidersConfig;
	target: ApiTarget;
	onRefresh: () => Promise<void>;
	readOnly: boolean;
	canConfigure: boolean;
	expectedRevision?: string;
}) {
	const [context, setContext] = useState<GatewaySdkContext>(() =>
		initialContext(provider)
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const tl = useLiteralMessages();
	const editable = !readOnly && canConfigure;
	const scope = provider.account_scope;
	const accounts = providers.accounts?.[scope];
	const submitContext = async () => {
		if (!editable) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await setGatewaySdkConnection(target, scope, {
				context,
				expectedRevision,
			});
			await onRefresh();
		} catch (cause) {
			setError(gatewayAccountErrorMessage(cause, "Connection update failed"));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div>
			{provider.context_kind === "default" ? null : (
				<SettingsItem
					actions={
						<Button
							disabled={!editable}
							loading={busy}
							onClick={submitContext}
							size="sm"
							variant="outline"
						>
							Save connection
						</Button>
					}
					title={tl("{providerName} connection", {
						providerName: provider.label,
					})}
				>
					<div className="w-full space-y-2">
						{context.kind === "vertex" ? (
							<div className="grid gap-2 sm:grid-cols-2">
								<label className="space-y-1 text-xs">
									Project
									<Input
										aria-label={tl("{providerName} project", {
											providerName: provider.label,
										})}
										disabled={!editable || busy}
										onChange={(event) =>
											setContext({ ...context, project: event.target.value })
										}
										value={context.project}
									/>
								</label>
								<label className="space-y-1 text-xs">
									Location
									<Input
										aria-label={tl("{providerName} location", {
											providerName: provider.label,
										})}
										disabled={!editable || busy}
										onChange={(event) =>
											setContext({ ...context, location: event.target.value })
										}
										value={context.location}
									/>
								</label>
							</div>
						) : null}
						{context.kind === "bedrock_api" ? (
							<label className="block space-y-1 text-xs">
								Region
								<Input
									aria-label={tl("{providerName} region", {
										providerName: provider.label,
									})}
									disabled={!editable || busy}
									onChange={(event) =>
										setContext({ ...context, region: event.target.value })
									}
									value={context.region}
								/>
							</label>
						) : null}
						{context.kind === "ollama" ? (
							<label className="block space-y-1 text-xs">
								Endpoint
								<Input
									aria-label={tl("{providerName} endpoint", {
										providerName: provider.label,
									})}
									disabled={!editable || busy}
									onChange={(event) =>
										setContext({ ...context, base_url: event.target.value })
									}
									value={context.base_url}
								/>
							</label>
						) : null}
						{provider.auth_kind === "no_auth" ? (
							<p className="text-muted-foreground text-xs">
								This endpoint does not use a provider key. Gateway client
								authentication is managed separately.
							</p>
						) : null}
						{error ? (
							<p className="text-status-destructive text-xs" role="alert">
								{error}
							</p>
						) : null}
					</div>
				</SettingsItem>
			)}
			{provider.context_kind === "default" ||
			provider.auth_kind === "no_auth" ? null : (
				<ItemSeparator className="my-0" />
			)}
			{provider.auth_kind === "no_auth" ? null : (
				<ProviderRow
					accountCount={provider.account_count}
					accounts={accounts}
					brand={provider.brand}
					canConfigure={canConfigure}
					credentialLabel={
						provider.auth_kind === "bearer_token" ? "access token" : "API key"
					}
					isSet={provider.account_count > 0}
					label={provider.label}
					onAdd={async (_scope, key) => {
						if (!editable) {
							return;
						}
						const result = await addGatewayProviderAccount(
							target,
							scope,
							key,
							expectedRevision
						);
						requireGatewayProviderReload(result);
						await onRefresh();
					}}
					onClear={async () => {
						if (!editable) {
							return;
						}
						const result = await clearGatewayProvider(
							target,
							scope,
							undefined,
							expectedRevision
						);
						requireGatewayProviderReload(result);
						await onRefresh();
					}}
					onConfigure={async (_scope, account) => {
						if (!editable) {
							return;
						}
						await configureGatewayProviderAccount(
							target,
							scope,
							account,
							expectedRevision
						);
						await onRefresh();
					}}
					onRemove={async (_scope, index) => {
						if (!editable) {
							return;
						}
						const result = await removeGatewayProviderAccount(
							target,
							scope,
							index,
							accounts?.[index]?.id,
							expectedRevision
						);
						requireGatewayProviderReload(result);
						await onRefresh();
					}}
					onReplace={async (_scope, account, key) => {
						if (!editable) {
							return;
						}
						await setGatewaySdkConnection(target, scope, {
							apiKey: key,
							accountId: account.id,
							expectedRevision,
						});
						await onRefresh();
					}}
					onSave={async (_scope, key) => {
						if (!editable) {
							return;
						}
						await setGatewaySdkConnection(target, scope, {
							apiKey: key,
							context,
							expectedRevision,
						});
						await onRefresh();
					}}
					placeholder={
						provider.auth_kind === "bearer_token" ? "Access token" : "API key"
					}
					readOnly={readOnly}
					readOnlyNote="Credentials supplied by the fleet administrator."
					slug={scope}
				/>
			)}
			{provider.activation_error ? (
				<p className="px-3 pb-2 text-muted-foreground text-xs">
					{provider.activation_error}
				</p>
			) : null}
			{provider.auth_kind === "bearer_token" ? (
				<p className="px-3 pb-2 text-muted-foreground text-xs">
					Supply a current token. Saving it does not set up OAuth login or
					automatic refresh.
				</p>
			) : null}
		</div>
	);
}

export function GatewaySdkAccounts({
	target,
	providers,
	onRefresh,
	managed = false,
	canConfigure = true,
	expectedRevision,
}: {
	target: ApiTarget;
	providers: GatewayProvidersConfig | null;
	onRefresh: () => Promise<void>;
	managed?: boolean;
	canConfigure?: boolean;
	expectedRevision?: string;
}) {
	const connections =
		providers?.genai?.sdk_providers?.filter(
			(provider) => provider.kind !== "gemini"
		) ?? [];
	if (!providers || connections.length === 0) {
		return null;
	}
	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"Manage API-key and token accounts independently. Existing native connections keep their own settings. These upstream credentials are separate from Gateway client keys."
					}
				>
					{"API-key and token accounts, separate from Gateway client keys."}
				</CaptionInfo>
			}
			headerAction={
				<Button onClick={onRefresh} size="sm" variant="ghost">
					Refresh accounts
				</Button>
			}
			title="Additional provider connections"
		>
			<SettingsGroup>
				{connections.map((provider) => (
					<Connection
						canConfigure={canConfigure}
						expectedRevision={expectedRevision}
						key={`${provider.provider_id}:${JSON.stringify(provider.context)}`}
						onRefresh={onRefresh}
						provider={provider}
						providers={providers}
						readOnly={
							managed ||
							provider.accounts.some((account) => account.source === "fleet")
						}
						target={target}
					/>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

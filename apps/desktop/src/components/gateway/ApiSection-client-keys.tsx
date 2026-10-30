import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { MorphIconSwap } from "@ryu/ui/components/morph-icon.tsx";
import { SensitiveValue } from "@ryu/ui/components/sensitive-value.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useRef, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayApiKey,
	type GatewayClientOperation,
	generateGatewayKey,
	registerByoaKey,
	removeByoaKey,
} from "@/src/lib/api/gateway.ts";
import {
	GatewayCliSetupSection,
	useGatewayCliSetup,
} from "./ApiSection-cli-setup.tsx";
import { CLIENT_OPERATIONS, COPIED_RESET_MS } from "./ApiSection-constants.ts";

// ── API key management ───────────────────────────────────────────────────────

export function GatewayClientKeys({
	target,
	managed,
	baseUrl,
	gatewayReady,
	canConfigure = true,
}: {
	canConfigure?: boolean;
	baseUrl: string;
	gatewayReady: boolean;
	managed: boolean;
	target: ApiTarget;
}) {
	const [keys, setKeys] = useState<GatewayApiKey[]>([]);
	const [operationGrantsSupported, setOperationGrantsSupported] =
		useState(false);
	const [allowedOperations, setAllowedOperations] = useState<
		GatewayClientOperation[]
	>(["inference"]);
	const [createdOperations, setCreatedOperations] = useState<
		GatewayClientOperation[]
	>([]);
	const activeTarget = useRef(target);
	const [requireAuth, setRequireAuth] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [creating, setCreating] = useState(false);
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [pastedKey, setPastedKey] = useState("");
	const hasInferenceCredential = Boolean(
		pastedKey.trim() || (createdKey && createdOperations.includes("inference"))
	);
	const cli = useGatewayCliSetup({
		baseUrl,
		createdKey,
		hasInferenceCredential,
		managed,
		pastedKey,
	});

	const load = async () => {
		try {
			const cfg = await fetchGatewayConfig(target);
			if (activeTarget.current !== target) {
				return;
			}
			setKeys(
				(cfg.auth?.api_keys ?? []).filter(
					(key) =>
						key.system_relay !== undefined ||
						(key.name !== "local-core" && key.name !== "local-inference")
				)
			);
			setRequireAuth(cfg.auth?.require_auth ?? false);
			setOperationGrantsSupported(cfg.webServiceSchema === 1);
			setLoadError(null);
		} catch (e) {
			if (activeTarget.current === target) {
				setLoadError(e instanceof Error ? e.message : "Failed to load keys");
			}
		} finally {
			if (activeTarget.current === target) {
				setLoading(false);
			}
		}
	};

	useEffect(() => {
		activeTarget.current = target;
		setCreating(false);
		setLoading(true);
		setActionError(null);
		setCreatedKey(null);
		setCreatedOperations([]);
		setAllowedOperations(["inference"]);
		setPastedKey("");
		setKeys([]);
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target]);

	const handleCreate = async () => {
		const name = newName.trim();
		if (
			!name ||
			creating ||
			!canConfigure ||
			managed ||
			(operationGrantsSupported && allowedOperations.length === 0)
		) {
			return;
		}
		if (keys.some((key) => key.name === name)) {
			setActionError("A Gateway client key already uses that name.");
			return;
		}
		setCreating(true);
		setActionError(null);
		setCreatedKey(null);
		try {
			const key = generateGatewayKey();
			const entry: GatewayApiKey = {
				key,
				name,
				trusted_forwarder: false,
				...(operationGrantsSupported
					? { allowed_operations: allowedOperations }
					: undefined),
			};
			await registerByoaKey(target, entry);
			if (activeTarget.current !== target) {
				return;
			}
			setCreatedKey(key);
			setCreatedOperations(
				operationGrantsSupported ? [...allowedOperations] : ["inference"]
			);
			setNewName("");
			await load();
		} catch (e) {
			if (activeTarget.current === target) {
				setActionError(e instanceof Error ? e.message : "Failed to create key");
			}
		} finally {
			if (activeTarget.current === target) {
				setCreating(false);
			}
		}
	};

	const handleRevoke = async (name: string) => {
		setActionError(null);
		if (!canConfigure || managed) {
			return;
		}
		try {
			await removeByoaKey(target, name);
			await load();
		} catch (e) {
			if (activeTarget.current === target) {
				setActionError(e instanceof Error ? e.message : "Failed to revoke key");
			}
		}
	};

	const copyCreated = async () => {
		if (!createdKey) {
			return;
		}
		try {
			await navigator.clipboard.writeText(createdKey);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			// Clipboard unavailable.
		}
	};

	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					managed
						? "Keys are issued and revoked in Console on the web."
						: "Keys for OpenAI, Anthropic or Gemini clients. A new key is shown only once."
				}
				title="Gateway client API keys"
			>
				{loading ? (
					<SettingsCard>
						<SkeletonRows label="Loading…" spacing="panel" />
					</SettingsCard>
				) : null}
				{loadError || actionError ? (
					<SettingsCard>
						<p className="text-sm text-status-destructive">
							{actionError ?? loadError}
						</p>
					</SettingsCard>
				) : null}

				{loading ? null : (
					<SettingsGroup>
						<SettingsItem
							actions={
								<span
									className={
										requireAuth
											? "text-muted-foreground text-sm"
											: "text-sm text-status-destructive"
									}
								>
									{requireAuth
										? "Authentication required"
										: "Authentication disabled"}
								</span>
							}
							description={
								loadError || requireAuth ? undefined : (
									<>
										Auth is currently disabled — requests are accepted without a
										key. Enable <span className="font-mono">require_auth</span>{" "}
										in the gateway config to require authentication.
									</>
								)
							}
							title="Authentication"
						/>
					</SettingsGroup>
				)}

				{managed ? null : (
					<SettingsGroup>
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									<Input
										autoComplete="off"
										className="h-8 w-56"
										disabled={!canConfigure}
										id="api-key-name"
										onChange={(e) => setNewName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												void handleCreate();
											}
										}}
										placeholder="e.g. Cursor, Claude Code, Gemini CLI"
										value={newName}
									/>
									<Button
										disabled={
											!newName.trim() ||
											creating ||
											!canConfigure ||
											(operationGrantsSupported &&
												allowedOperations.length === 0)
										}
										onClick={() => void handleCreate()}
										size="sm"
										variant="outline"
									>
										{creating ? "Creating…" : "Create key"}
									</Button>
								</div>
							}
							title={<label htmlFor="api-key-name">Key name</label>}
						/>
						{operationGrantsSupported ? (
							<SettingsItem
								actions={
									<fieldset
										aria-label="Allowed services"
										className="flex flex-wrap gap-4"
									>
										{CLIENT_OPERATIONS.map(({ id, label }) => (
											<label
												className="flex items-center gap-2 text-xs"
												key={id}
											>
												<Checkbox
													checked={allowedOperations.includes(id)}
													disabled={!canConfigure || creating}
													onCheckedChange={(checked) =>
														setAllowedOperations((current) =>
															checked
																? [
																		...current.filter((value) => value !== id),
																		id,
																	]
																: current.filter((value) => value !== id)
														)
													}
												/>
												{label}
											</label>
										))}
									</fieldset>
								}
								title="Allowed services"
							/>
						) : null}
					</SettingsGroup>
				)}

				{createdKey ? (
					<SettingsCard>
						<div className="flex items-start gap-3">
							<div className="min-w-0 flex-1">
								<p className="font-medium text-sm">Copy your key now</p>
								<p className="break-all font-mono text-muted-foreground text-xs">
									<SensitiveValue label="API key" value={createdKey} />
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									It won&apos;t be shown again.
								</p>
							</div>
							<Button
								onClick={() => void copyCreated()}
								size="sm"
								variant="ghost"
							>
								<MorphIconSwap
									a={Copy01Icon}
									b={Tick01Icon}
									className="size-4"
									state={copied ? "b" : "a"}
								/>
								{copied ? "Copied" : "Copy"}
							</Button>
						</div>
					</SettingsCard>
				) : null}

				{loading || loadError ? null : (
					<SettingsGroup>
						{keys.length === 0 ? (
							<SettingsItem
								title={
									<span className="text-muted-foreground">No keys yet</span>
								}
							/>
						) : (
							keys.map((k) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											{k.system_relay ? (
												<span className="text-muted-foreground text-xs">
													System relay
												</span>
											) : null}
											{k.trusted_forwarder ? (
												<span className="text-muted-foreground text-xs">
													Trusted
												</span>
											) : null}
											{managed || k.system_relay ? null : (
												<Button
													disabled={!canConfigure}
													onClick={() => void handleRevoke(k.name)}
													size="sm"
													variant="ghost"
												>
													Revoke
												</Button>
											)}
										</div>
									}
									description={
										<span className="flex flex-wrap items-center gap-x-3 gap-y-1">
											<span className="font-mono text-xs">
												{maskKey(k.key)}
											</span>
											{operationGrantsSupported && k.allowed_operations ? (
												<span className="text-xs">
													{CLIENT_OPERATIONS.filter((operation) =>
														k.allowed_operations?.includes(operation.id)
													)
														.map((operation) => operation.label)
														.join(" · ")}
												</span>
											) : null}
										</span>
									}
									key={k.name}
									title={k.name}
								/>
							))
						)}
					</SettingsGroup>
				)}
			</SettingsSection>

			{managed ? null : (
				<GatewayCliSetupSection
					cli={cli}
					createdKey={createdKey}
					gatewayReady={gatewayReady}
					pastedKey={pastedKey}
					setPastedKey={setPastedKey}
				/>
			)}
		</div>
	);
}

function maskKey(key: string): string {
	if (key === "***") {
		return "••••••••";
	}
	if (key.length <= 6) {
		return `${key}…`;
	}
	return `${key.slice(0, 6)}…`;
}

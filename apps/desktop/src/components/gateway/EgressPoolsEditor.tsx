import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayEgressConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { restartGateway } from "@/src/lib/api/system.ts";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";

type Pool = GatewayEgressConfig["pools"][string];
type Endpoint = Pool["endpoints"][number];
type DraftEndpoint = Endpoint & { draftId: string };
type DraftPool = Omit<Pool, "endpoints"> & { endpoints: DraftEndpoint[] };

const SUPPORTED = new Set([
	"openai",
	"edge-tts",
	"google-tts",
	"google-translate-tts",
	"polly",
	"anthropic",
	"openrouter",
	"cohere",
	"deepgram",
	"assemblyai",
	"elevenlabs",
	"inworld",
	"modal",
	"replicate",
	"fal",
	"recraft",
	"stability",
	"bfl",
	"minimax",
	"runway",
	"topaz",
	"genai",
	"cloudflare",
	"bedrock",
	"vertex",
	"openai-credits",
	"anthropic-credits",
	"voyage",
	"jina",
	"mistral",
	"huggingface",
	"nvidia",
	"together",
	"fireworks",
	"qwen",
	"chutes",
	"hyperbolic",
	"siliconflow",
	"venice",
	"featherless",
]);
const EMPTY_EGRESS: GatewayEgressConfig = { assignments: {}, pools: {} };
/** The Gateway accepts new credential variable names only with this prefix. */
const WRITABLE_CREDENTIAL_ENV_PREFIX = "RYU_PROXY_";
const WELL_FORMED_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Every credential variable name the saved config already uses. */
function savedCredentialEnvNames(
	egress: GatewayEgressConfig | null
): ReadonlySet<string> {
	const names = new Set<string>();
	for (const saved of Object.values(egress?.pools ?? {})) {
		for (const endpoint of saved.endpoints) {
			for (const env of [endpoint.username_env, endpoint.password_env]) {
				if (env) {
					names.add(env);
				}
			}
		}
	}
	return names;
}

function validatePool(
	name: string,
	pool: Pool,
	savedEnvNames: ReadonlySet<string> = new Set()
): string | null {
	if (pool.direct_fallback_only && !pool.include_direct) {
		return "Include a direct connection before enabling direct fallback.";
	}
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
		return "Use 1–64 letters, numbers, hyphens, or underscores for the pool name.";
	}
	if (
		!(
			pool.include_direct || pool.endpoints.some((endpoint) => endpoint.enabled)
		)
	) {
		return "Enable a proxy endpoint or include a direct connection.";
	}
	if (pool.endpoints.length + Number(pool.include_direct) > 32) {
		return "A pool supports at most 32 connections.";
	}
	const ids = new Set<string>();
	for (const endpoint of pool.endpoints) {
		if (
			!Number.isInteger(endpoint.priority ?? 0) ||
			(endpoint.priority ?? 0) < 0 ||
			(endpoint.priority ?? 0) > 65_535
		) {
			return "Priority must be an integer from 0 to 65535.";
		}
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(endpoint.id) || ids.has(endpoint.id)) {
			return "Proxy endpoint IDs must be unique and use letters, numbers, hyphens, or underscores.";
		}
		ids.add(endpoint.id);
		if (endpoint.enabled) {
			let url: URL;
			try {
				url = new URL(endpoint.url);
			} catch {
				return `Enter a valid URL for ${endpoint.id}.`;
			}
			if (
				!(url.protocol === "http:" || url.protocol === "https:") ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			) {
				return `Use an HTTP or HTTPS proxy origin without credentials or a path for ${endpoint.id}.`;
			}
		}
		if (Boolean(endpoint.username_env) !== Boolean(endpoint.password_env)) {
			return `Set both credential environment variable names for ${endpoint.id}.`;
		}
		for (const env of [endpoint.username_env, endpoint.password_env]) {
			if (
				env &&
				WELL_FORMED_ENV_NAME.test(env) &&
				!env.startsWith(WRITABLE_CREDENTIAL_ENV_PREFIX) &&
				!savedEnvNames.has(env)
			) {
				return `Credential variable names for ${endpoint.id} must start with ${WRITABLE_CREDENTIAL_ENV_PREFIX}.`;
			}
		}
	}
	return null;
}

export function EgressPoolsEditor({
	target,
	reachable,
	canConfigure,
	providers,
}: {
	target: ApiTarget;
	reachable: boolean;
	canConfigure: boolean;
	providers: string[];
}) {
	const [egress, setEgress] = useState<GatewayEgressConfig | null>(null);
	const [unsupported, setUnsupported] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [pool, setPool] = useState<DraftPool>({
		include_direct: false,
		direct_fallback_only: false,
		endpoints: [],
	});
	const [provider, setProvider] = useState("");
	const [assignment, setAssignment] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		if (!reachable) {
			return;
		}
		let active = true;
		fetchGatewayConfig(target)
			.then((config) => {
				if (active) {
					setUnsupported(config.egress === undefined);
					setEgress(config.egress ?? EMPTY_EGRESS);
				}
			})
			.catch((cause) => {
				if (active) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load proxy pools."
					);
				}
			});
		return () => {
			active = false;
		};
	}, [reachable, target]);

	const persist = async (
		change: (current: GatewayEgressConfig) => GatewayEgressConfig
	): Promise<boolean> => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const config = await fetchGatewayConfig(target);
			if (config.egress === undefined) {
				throw new Error("This Gateway does not support proxy pool editing.");
			}
			const next = change(config.egress);
			await updateGatewayConfig(target, { egress: next });
			const restarted = await restartGateway(target).catch(() => false);
			setEgress(next);
			setNotice(
				restarted
					? "Saved and restarted Gateway."
					: "Saved. Restart Gateway to apply the proxy pools."
			);
			return true;
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save proxy pools."
			);
			return false;
		} finally {
			setBusy(false);
		}
	};

	const begin = (poolName?: string) => {
		setEditing(poolName ?? "");
		setName(poolName ?? "");
		const saved = poolName ? egress?.pools[poolName] : undefined;
		setPool({
			include_direct: saved?.include_direct ?? false,
			direct_fallback_only: saved?.direct_fallback_only ?? false,
			endpoints:
				saved?.endpoints.map((endpoint) => ({
					...endpoint,
					draftId: crypto.randomUUID(),
				})) ?? [],
		});
		setError(null);
		setNotice(null);
	};

	const savePool = async () => {
		const normalized = name.trim();
		const problem = validatePool(
			normalized,
			pool,
			savedCredentialEnvNames(egress)
		);
		if (problem) {
			setError(problem);
			return;
		}
		if (editing === "" && egress?.pools[normalized]) {
			setError("A pool with that name already exists.");
			return;
		}
		const saved = await persist((current) => {
			if (editing === "" && current.pools[normalized]) {
				throw new Error("A pool with that name already exists.");
			}
			const endpoints = pool.endpoints.map(
				({ draftId: _draftId, ...endpoint }) => endpoint
			);
			const pools = { ...current.pools, [normalized]: { ...pool, endpoints } };
			const assignments = { ...current.assignments };
			if (editing && editing !== normalized) {
				delete pools[editing];
				for (const [key, value] of Object.entries(assignments)) {
					if (value === editing) {
						assignments[key] = normalized;
					}
				}
			}
			return { pools, assignments };
		});
		if (saved) {
			setEditing(null);
		}
	};

	const updateEndpoint = (index: number, patch: Partial<Endpoint>) => {
		setPool((current) => ({
			...current,
			endpoints: current.endpoints.map((item, at) =>
				at === index ? { ...item, ...patch } : item
			),
		}));
	};

	const connected = providers.filter((id) => SUPPORTED.has(id));
	const disabled = !(reachable && canConfigure) || busy || unsupported;

	/** One labelled text field of a draft proxy endpoint, as a settings row. */
	const endpointField = ({
		id,
		index,
		label,
		patch,
		placeholder,
		value,
	}: {
		id: string;
		index: number;
		label: string;
		patch: (value: string) => Partial<Endpoint>;
		placeholder?: string;
		value: string;
	}) => (
		<SettingsItem
			actions={
				<div>
					<Input
						className="h-8 w-56"
						disabled={disabled}
						id={id}
						onChange={(event) =>
							updateEndpoint(index, patch(event.target.value))
						}
						placeholder={placeholder}
						value={value}
					/>
				</div>
			}
			key={id}
			title={<label htmlFor={id}>{label}</label>}
		/>
	);

	const selectClass =
		"rounded-md border border-input bg-background px-2 py-1 text-sm";

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Choose how direct provider requests leave this node. Assigned chat sessions stay on one proxy; other calls rotate per request. Failed proxy connections can use another endpoint; uncertain delivery returns an error. Proxy credentials come from Gateway environment variables."
				headerAction={
					egress && !unsupported ? (
						<Button
							disabled={disabled || Object.keys(egress.pools).length >= 128}
							onClick={() => begin()}
							size="sm"
							variant="ghost"
						>
							Create pool
						</Button>
					) : null
				}
				title="Outbound proxy pools"
			>
				{unsupported ? (
					<SettingsCard>
						<p className="text-muted-foreground text-sm">
							This Gateway version does not expose proxy pools for editing.
						</p>
					</SettingsCard>
				) : null}
				{egress && !unsupported ? (
					Object.keys(egress.pools).length === 0 ? (
						<SettingsCard>
							<p className="text-center text-muted-foreground text-sm">
								No proxy pools yet.
							</p>
						</SettingsCard>
					) : (
						<SettingsGroup>
							{Object.entries(egress.pools).map(([poolName, current]) => (
								<SettingsItem
									actions={
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground text-sm">
												{
													current.endpoints.filter(
														(endpoint) => endpoint.enabled
													).length
												}{" "}
												proxies{current.include_direct ? " + direct" : ""}
											</span>
											<Button
												aria-label={`Edit proxy pool ${poolName}`}
												disabled={disabled}
												onClick={() => begin(poolName)}
												size="sm"
												variant="ghost"
											>
												Edit
											</Button>
											<Button
												aria-label={`Remove proxy pool ${poolName}`}
												disabled={disabled}
												onClick={() => {
													void persist((value) => {
														if (
															Object.values(value.assignments).includes(
																poolName
															)
														) {
															throw new Error(
																"Remove provider assignments before deleting this pool."
															);
														}
														const pools = { ...value.pools };
														delete pools[poolName];
														return { ...value, pools };
													});
												}}
												size="sm"
												variant="ghost"
											>
												Remove
											</Button>
										</div>
									}
									key={poolName}
									title={poolName}
								/>
							))}
						</SettingsGroup>
					)
				) : null}
			</SettingsSection>

			{egress && !unsupported && editing !== null ? (
				<SettingsSection
					headerAction={
						<div className="flex flex-wrap gap-1">
							<Button
								disabled={
									disabled ||
									pool.endpoints.length + Number(pool.include_direct) >= 32
								}
								onClick={() =>
									setPool((current) => ({
										...current,
										endpoints: [
											...current.endpoints,
											{
												draftId: crypto.randomUUID(),
												id: `proxy-${current.endpoints.length + 1}`,
												url: "",
												enabled: true,
												username_env: null,
												password_env: null,
											},
										],
									}))
								}
								size="sm"
								variant="ghost"
							>
								Add proxy
							</Button>
							<Button
								disabled={busy}
								onClick={() => setEditing(null)}
								size="sm"
								variant="ghost"
							>
								Cancel
							</Button>
							<Button
								disabled={disabled}
								onClick={() => {
									void savePool();
								}}
								size="sm"
							>
								Save pool
							</Button>
						</div>
					}
					title={editing ? `Edit ${editing}` : "New pool"}
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<div>
									<Input
										className="h-8 w-56"
										disabled={disabled}
										id="egress-pool-name"
										onChange={(event) => setName(event.target.value)}
										value={name}
									/>
								</div>
							}
							title={<label htmlFor="egress-pool-name">Pool name</label>}
						/>
						<SettingsItem
							actions={
								<Switch
									checked={pool.include_direct}
									disabled={disabled}
									id="egress-direct"
									onCheckedChange={(checked) =>
										setPool((current) => ({
											...current,
											include_direct: checked,
											direct_fallback_only: checked
												? current.direct_fallback_only
												: false,
										}))
									}
								/>
							}
							title={
								<label htmlFor="egress-direct">Include direct connection</label>
							}
						/>
						<SettingsItem
							actions={
								<Switch
									checked={pool.direct_fallback_only ?? false}
									disabled={disabled || !pool.include_direct}
									id="egress-direct-fallback"
									onCheckedChange={(checked) =>
										setPool((current) => ({
											...current,
											direct_fallback_only: checked,
										}))
									}
								/>
							}
							title={
								<label htmlFor="egress-direct-fallback">
									Use direct only as fallback
								</label>
							}
						/>
					</SettingsGroup>
					{pool.endpoints.map((endpoint, index) => (
						<SettingsGroup key={endpoint.draftId}>
							<SettingsItem
								actions={
									<div className="flex items-center gap-2">
										<Switch
											checked={endpoint.enabled}
											disabled={disabled}
											id={`egress-enabled-${index}`}
											onCheckedChange={(checked) =>
												updateEndpoint(index, { enabled: checked })
											}
										/>
										<Button
											disabled={disabled}
											onClick={() =>
												setPool((current) => ({
													...current,
													endpoints: current.endpoints.filter(
														(_, at) => at !== index
													),
												}))
											}
											size="sm"
											variant="ghost"
										>
											Remove endpoint
										</Button>
									</div>
								}
								title={
									<label htmlFor={`egress-enabled-${index}`}>Enabled</label>
								}
							/>
							<SettingsItem
								actions={
									<div>
										<Input
											className="h-8 w-28"
											disabled={disabled}
											id={`egress-priority-${index}`}
											max={65_535}
											min={0}
											onChange={(event) =>
												updateEndpoint(index, {
													priority: Number(event.target.value),
												})
											}
											step={1}
											type="number"
											value={endpoint.priority ?? 0}
										/>
									</div>
								}
								title={
									<label htmlFor={`egress-priority-${index}`}>
										Priority (lower first)
									</label>
								}
							/>
							{endpointField({
								id: `egress-id-${index}`,
								index,
								label: "Endpoint ID",
								patch: (id) => ({ id }),
								value: endpoint.id,
							})}
							{endpointField({
								id: `egress-url-${index}`,
								index,
								label: "Proxy URL",
								patch: (url) => ({ url }),
								placeholder: "http://127.0.0.1:8080",
								value: endpoint.url,
							})}
							{endpointField({
								id: `egress-user-${index}`,
								index,
								label: "Username environment variable",
								patch: (env) => ({ username_env: env || null }),
								placeholder: "RYU_PROXY_USER",
								value: endpoint.username_env ?? "",
							})}
							{endpointField({
								id: `egress-password-${index}`,
								index,
								label: "Password environment variable",
								patch: (env) => ({ password_env: env || null }),
								placeholder: "RYU_PROXY_PASSWORD",
								value: endpoint.password_env ?? "",
							})}
						</SettingsGroup>
					))}
				</SettingsSection>
			) : null}

			{egress && !unsupported ? (
				<SettingsSection title="Provider assignments">
					<SettingsGroup>
						{Object.entries(egress.assignments).map(([id, poolName]) => (
							<SettingsItem
								actions={
									<Button
										aria-label={`Remove proxy assignment for ${id}`}
										disabled={disabled}
										onClick={() => {
											void persist((current) => {
												const assignments = { ...current.assignments };
												delete assignments[id];
												return { ...current, assignments };
											});
										}}
										size="sm"
										variant="ghost"
									>
										Remove
									</Button>
								}
								key={id}
								title={
									<>
										{svglForProvider(id) ? (
											<ProviderBrandLogo providerKey={id} size={16} />
										) : (
											<HugeiconsIcon
												className="size-4 text-muted-foreground"
												icon={Key01Icon}
											/>
										)}
										<span>
											{id} → {poolName}
										</span>
									</>
								}
							/>
						))}
						<SettingsItem
							actions={
								<div className="flex flex-wrap items-center gap-2">
									<label className="flex items-center gap-1.5 text-muted-foreground text-xs">
										Provider
										<select
											className={selectClass}
											disabled={disabled}
											onChange={(event) => setProvider(event.target.value)}
											value={provider}
										>
											<option value="">Select provider</option>
											{connected.map((id) => (
												<option key={id} value={id}>
													{id}
												</option>
											))}
										</select>
									</label>
									<label className="flex items-center gap-1.5 text-muted-foreground text-xs">
										Pool
										<select
											className={selectClass}
											disabled={disabled}
											onChange={(event) => setAssignment(event.target.value)}
											value={assignment}
										>
											<option value="">Select pool</option>
											{Object.keys(egress.pools).map((id) => (
												<option key={id} value={id}>
													{id}
												</option>
											))}
										</select>
									</label>
									<Button
										disabled={disabled || !provider || !assignment}
										onClick={() => {
											void persist((current) => ({
												...current,
												assignments: {
													...current.assignments,
													[provider]: assignment,
												},
											}));
										}}
										size="sm"
										variant="secondary"
									>
										Assign
									</Button>
								</div>
							}
							title="New assignment"
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}

			{error || notice ? (
				<div className="space-y-1 px-3.5">
					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
					{notice ? (
						<p className="text-sm text-status-success" role="status">
							{notice}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

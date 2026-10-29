import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { sileo } from "sileo";
import { z } from "zod";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchOpenRouterProviders,
	type OpenRouterProvider,
} from "@/src/lib/api/openrouter.ts";
import { hasOrgAuth } from "@/src/lib/api/orgs.ts";
import {
	EMPTY_NODE_ROUTING_PREFERENCES,
	getNodeRoutingPreferences,
	NODE_ROUTING_PREFS_MAX_BYTES,
	type NodeRoutingPreferences,
	type OpenRouterOption,
	type OpenRouterOptions,
	openRouterOptionsSchema,
	parseNodeRoutingPreferences,
	serializeNodeRoutingPreferences,
	setNodeRoutingPreferences,
} from "@/src/lib/api/preferences.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const EMPTY_PATTERNS = "";
const PROVIDER_LIST_ID = "openrouter-provider-catalog";
const QUANTIZATIONS = [
	"int4",
	"int8",
	"fp4",
	"mxfp4",
	"nvfp4",
	"fp6",
	"fp8",
	"mxfp8",
	"fp16",
	"bf16",
	"fp32",
	"unknown",
] as const;
const PERCENTILES = ["p50", "p75", "p90", "p99"] as const;
const SORT_STRATEGIES = ["price", "throughput", "latency"] as const;
type Percentile = (typeof PERCENTILES)[number];

/** Sparse numeric values for the four percentile controls authored below. */
interface PercentileValues {
	p50?: number;
	p75?: number;
	p90?: number;
	p99?: number;
}
type ProviderListKey = "only" | "ignore";

function isRecord(
	value: Parameters<typeof openRouterOptionsSchema.safeParse>[0]
): value is OpenRouterOptions {
	return openRouterOptionsSchema.safeParse(value).success;
}

function patternsText(prefs: NodeRoutingPreferences): string {
	const patterns = prefs.firewall?.custom_patterns ?? [];
	return patterns.length > 0
		? JSON.stringify(patterns, null, 2)
		: EMPTY_PATTERNS;
}

function formatOpenRouterOptions(
	options: NodeRoutingPreferences["openrouter"]
): string {
	return options ? JSON.stringify(options, null, 2) : "";
}

function parsePatterns(raw: string): NodeRoutingPreferences["firewall"] {
	if (!raw.trim()) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("Extra firewall rules must be valid JSON.");
	}
	if (!Array.isArray(value)) {
		throw new Error("Extra firewall rules must be a JSON array.");
	}
	const parsed = parseNodeRoutingPreferences(
		JSON.stringify({ firewall: { custom_patterns: value } })
	);
	if (parsed.firewall?.custom_patterns.length !== value.length) {
		throw new Error(
			"Each rule needs a kind (pii, secret, or prompt_injection), name, and regex."
		);
	}
	return parsed.firewall;
}

function parseOpenRouterOptions(raw: string): OpenRouterOptions | null {
	if (!raw.trim()) {
		return null;
	}
	let parsed: ReturnType<typeof openRouterOptionsSchema.safeParse>;
	try {
		parsed = openRouterOptionsSchema.safeParse(JSON.parse(raw));
	} catch {
		throw new Error("Advanced OpenRouter options must be valid JSON.");
	}
	if (!parsed.success) {
		throw new Error("Advanced OpenRouter options must be a JSON object.");
	}
	return parsed.data;
}

function stringList(value: OpenRouterOption | undefined): string[] {
	return Array.isArray(value)
		? value.flatMap((entry) => {
				const parsed = z.string().safeParse(entry);
				return parsed.success ? [parsed.data] : [];
			})
		: [];
}

function withOption(
	options: OpenRouterOptions | null,
	key: string,
	value: OpenRouterOption | undefined
): OpenRouterOptions | null {
	const next: OpenRouterOptions = Object.fromEntries(
		Object.entries(options ?? {}).filter(([entryKey]) => entryKey !== key)
	);
	if (value !== undefined && value !== null) {
		next[key] = value;
	}
	return Object.keys(next).length > 0 ? next : null;
}

function optionNumber(options: OpenRouterOptions | null, key: string) {
	const parsed = z.number().finite().safeParse(options?.[key]);
	return parsed.success ? parsed.data : undefined;
}

function percentileValues(
	options: OpenRouterOptions | null,
	key: string
): PercentileValues {
	const value = options?.[key];
	const numeric = z.number().finite().safeParse(value);
	if (numeric.success) {
		return { p50: numeric.data };
	}
	if (!isRecord(value)) {
		return {};
	}
	const result: PercentileValues = {};
	for (const percentile of PERCENTILES) {
		const parsed = z.number().finite().safeParse(value[percentile]);
		if (parsed.success) {
			result[percentile] = parsed.data;
		}
	}
	return result;
}

function sortStrategy(options: OpenRouterOptions | null): string {
	const sort = options?.sort;
	const parsed = z.enum(SORT_STRATEGIES).safeParse(sort);
	return parsed.success
		? parsed.data
		: sort === undefined
			? "default"
			: "custom";
}

function sortStrategyLabel(value: string): string {
	if (value === "throughput") {
		return "Higher throughput first";
	}
	if (value === "latency") {
		return "Lower latency first";
	}
	if (value === "price") {
		return "Lower price first";
	}
	if (value === "custom") {
		return "Custom (advanced JSON)";
	}
	return "OpenRouter health-aware default";
}

function dataCollectionLabel(value: string): string {
	if (value === "allow") {
		return "Allow collection";
	}
	if (value === "deny") {
		return "Exclude data-collecting providers";
	}
	return "OpenRouter default";
}

function providerName(providers: OpenRouterProvider[], slug: string): string {
	return providers.find((provider) => provider.slug === slug)?.name ?? slug;
}

function OpenRouterProviderPicker({
	onChange,
	placeholder,
	buttonLabel,
	locked,
}: {
	onChange: (slug: string) => void;
	placeholder: string;
	buttonLabel: string;
	locked?: boolean;
}) {
	const [candidate, setCandidate] = useState("");
	const add = () => {
		const slug = candidate.trim().toLowerCase();
		if (!slug) {
			return;
		}
		onChange(slug);
		setCandidate("");
	};

	return (
		<div className="flex min-w-0 gap-2">
			<Input
				aria-label="OpenRouter provider slug"
				autoComplete="off"
				className="min-w-0"
				disabled={locked}
				list={PROVIDER_LIST_ID}
				onChange={(event) => setCandidate(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						add();
					}
				}}
				placeholder={placeholder}
				value={candidate}
			/>
			<Button disabled={locked || !candidate.trim()} onClick={add} size="sm">
				{buttonLabel}
			</Button>
		</div>
	);
}

function ProviderListEditor({
	label,
	providers,
	values,
	onChange,
	disabled,
}: {
	label: string;
	providers: OpenRouterProvider[];
	values: string[];
	onChange: (values: string[]) => void;
	disabled: boolean;
}) {
	const add = (slug: string) => {
		if (!values.includes(slug)) {
			onChange([...values, slug]);
		}
	};
	return (
		<div className="space-y-2">
			<p className="text-sm">{label}</p>
			<OpenRouterProviderPicker
				buttonLabel="Add"
				locked={disabled}
				onChange={add}
				placeholder="Search providers or enter a slug"
			/>
			{values.length > 0 ? (
				<div className="flex flex-wrap gap-2">
					{values.map((slug) => (
						<span
							className="inline-flex items-center gap-2 rounded-full bg-muted py-0.5 pr-0.5 pl-3 text-xs"
							key={slug}
						>
							<span>{providerName(providers, slug)}</span>
							<code className="text-muted-foreground">{slug}</code>
							<Button
								aria-label={`Remove ${slug}`}
								disabled={disabled}
								onClick={() => onChange(values.filter((item) => item !== slug))}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}

function OrderedProviderEditor({
	providers,
	values,
	onChange,
	disabled,
}: {
	providers: OpenRouterProvider[];
	values: string[];
	onChange: (values: string[]) => void;
	disabled: boolean;
}) {
	const add = (slug: string) => {
		if (!values.includes(slug)) {
			onChange([...values, slug]);
		}
	};
	const move = (index: number, direction: -1 | 1) => {
		const nextIndex = index + direction;
		if (nextIndex < 0 || nextIndex >= values.length) {
			return;
		}
		const next = [...values];
		[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
		onChange(next);
	};

	return (
		<div className="space-y-3">
			<OpenRouterProviderPicker
				buttonLabel="Add provider"
				locked={disabled}
				onChange={add}
				placeholder="Search providers or enter a slug"
			/>
			{values.length > 0 ? (
				<ol className="divide-y divide-border/60">
					{values.map((slug, index) => (
						<li
							className="flex flex-wrap items-center justify-between gap-2 py-1.5"
							key={`${slug}-${index}`}
						>
							<span className="min-w-0">
								<span className="mr-2 inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs">
									{index + 1}
								</span>
								<span className="font-medium text-sm">
									{providerName(providers, slug)}
								</span>
								<code className="ml-2 text-muted-foreground text-xs">
									{slug}
								</code>
							</span>
							<span className="flex gap-1">
								<Button
									aria-label={`Move ${slug} up`}
									disabled={disabled || index === 0}
									onClick={() => move(index, -1)}
									size="sm"
									variant="ghost"
								>
									Move up
								</Button>
								<Button
									aria-label={`Move ${slug} down`}
									disabled={disabled || index === values.length - 1}
									onClick={() => move(index, 1)}
									size="sm"
									variant="ghost"
								>
									Move down
								</Button>
								<Button
									aria-label={`Remove ${slug}`}
									disabled={disabled}
									onClick={() =>
										onChange(values.filter((item) => item !== slug))
									}
									size="sm"
									variant="ghost"
								>
									Remove
								</Button>
							</span>
						</li>
					))}
				</ol>
			) : (
				<p className="text-muted-foreground text-xs">
					No order is set. OpenRouter can choose the healthiest matching
					provider.
				</p>
			)}
		</div>
	);
}

function numericText(value: number | undefined): string {
	return value === undefined ? "" : String(value);
}

/**
 * Node-owned preferences carried with requests sent to the managed fleet.
 * OpenRouter controls are org-scoped and visible to Business organizations;
 * the hosted fleet still enforces budgets, credentials, and locked privacy rules.
 */
export function NodeRoutingSettings() {
	const active = toTarget(useActiveNode());
	const userJwt = active.userJwt ?? null;
	const instance = useId();
	const sequence = useRef(0);
	const target = useMemo(
		() => ({ url: active.url, token: active.token, userJwt }),
		[active.url, active.token, userJwt]
	);
	const scope = useMemo(
		() => `${instance}:${++sequence.current}`,
		[instance, target]
	);
	return <ScopedNodeRoutingSettings key={scope} target={target} />;
}

function ScopedNodeRoutingSettings({ target }: { target: ApiTarget }) {
	const [prefs, setPrefs] = useState<NodeRoutingPreferences>(
		EMPTY_NODE_ROUTING_PREFERENCES
	);
	const [fallback, setFallback] = useState("");
	const [patterns, setPatterns] = useState(EMPTY_PATTERNS);
	const [advancedDraft, setAdvancedDraft] = useState<string | null>(null);
	const [advancedError, setAdvancedError] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const current = useRef(true);
	const readVersion = useRef(0);
	const pending = useRef(false);
	const [saving, setSaving] = useState(false);
	const [providers, setProviders] = useState<OpenRouterProvider[]>([]);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogReload, setCatalogReload] = useState(0);
	const billing = useOrgBillingStatus();
	const authenticated = hasOrgAuth();
	const businessOrg =
		authenticated &&
		billing.activeOrgId !== null &&
		!billing.loading &&
		billing.plan === "business" &&
		billing.billing?.scope !== "user" &&
		(!billing.billing?.organizationId ||
			billing.billing.organizationId === billing.activeOrgId);
	const providerOptions = prefs.openrouter;
	const advancedText =
		advancedDraft ?? formatOpenRouterOptions(providerOptions);
	const load = useCallback(async () => {
		const version = ++readVersion.current;
		setLoaded(false);
		setLoadError(null);
		try {
			const loadedPrefs = await getNodeRoutingPreferences(target);
			if (!current.current || version !== readVersion.current) {
				return;
			}
			setPrefs(loadedPrefs);
			setFallback(loadedPrefs.fallback.join(", "));
			setPatterns(patternsText(loadedPrefs));
			setAdvancedDraft(null);
			setLoaded(true);
		} catch {
			if (current.current && version === readVersion.current) {
				setLoadError(
					"Could not load routing preferences. Saved policy is unavailable; retry before editing."
				);
			}
		}
	}, [target]);
	useEffect(() => {
		current.current = true;
		void load();
		return () => {
			current.current = false;
			readVersion.current += 1;
		};
	}, [load]);

	useEffect(() => {
		if (!businessOrg) {
			return;
		}
		let cancelled = false;
		fetchOpenRouterProviders()
			.then((catalog) => {
				if (!cancelled) {
					setProviders(catalog);
					setCatalogError(null);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setCatalogError(
						"Provider list is unavailable. You can still enter a slug."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [businessOrg, catalogReload]);

	const changeOption = (key: string, value: OpenRouterOption | undefined) => {
		setPrefs((current) => ({
			...current,
			openrouter: withOption(current.openrouter, key, value),
		}));
		setAdvancedDraft(null);
		setAdvancedError(null);
	};

	const changeProviderList = (
		key: "order" | ProviderListKey,
		values: string[]
	) => {
		changeOption(key, values.length > 0 ? values : undefined);
	};

	const changePercentile = (
		key: "preferred_min_throughput" | "preferred_max_latency",
		percentile: Percentile,
		raw: string
	) => {
		const parsed = raw.trim() ? Number(raw) : undefined;
		setPrefs((current) => {
			const nextPercentiles = percentileValues(current.openrouter, key);
			if (parsed === undefined || !Number.isFinite(parsed)) {
				delete nextPercentiles[percentile];
			} else {
				nextPercentiles[percentile] = parsed;
			}
			const value = Object.keys(nextPercentiles).length
				? openRouterOptionsSchema.parse(nextPercentiles)
				: undefined;
			return {
				...current,
				openrouter: withOption(current.openrouter, key, value),
			};
		});
		setAdvancedDraft(null);
		setAdvancedError(null);
	};

	const changePrice = (
		key: "prompt" | "completion" | "request" | "image",
		raw: string
	) => {
		const parsed = raw.trim() ? Number(raw) : undefined;
		setPrefs((current) => {
			const price = isRecord(current.openrouter?.max_price)
				? { ...current.openrouter.max_price }
				: {};
			if (parsed === undefined || !Number.isFinite(parsed)) {
				delete price[key];
			} else {
				price[key] = parsed;
			}
			return {
				...current,
				openrouter: withOption(
					current.openrouter,
					"max_price",
					Object.keys(price).length > 0 ? price : undefined
				),
			};
		});
		setAdvancedDraft(null);
		setAdvancedError(null);
	};

	const save = async () => {
		if (!loaded || pending.current) {
			return;
		}
		let firewall: NodeRoutingPreferences["firewall"];
		try {
			firewall = parsePatterns(patterns);
			if (advancedError) {
				throw new Error(advancedError);
			}
			if (advancedDraft !== null) {
				parseOpenRouterOptions(advancedDraft);
			}
		} catch (error) {
			sileo.error({
				title: "Could not save routing preferences",
				description:
					error instanceof Error
						? error.message
						: "Invalid routing preferences",
			});
			return;
		}

		const nextPrefs: NodeRoutingPreferences = {
			...prefs,
			fallback: fallback
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
			firewall,
		};
		const serialized = serializeNodeRoutingPreferences(nextPrefs);
		if (
			new TextEncoder().encode(serialized).byteLength >
			NODE_ROUTING_PREFS_MAX_BYTES
		) {
			sileo.error({
				title: "Routing preferences are too large",
				description: `Keep the saved settings under ${NODE_ROUTING_PREFS_MAX_BYTES.toLocaleString()} bytes. Remove some provider entries or advanced options and try again.`,
			});
			return;
		}

		pending.current = true;
		setSaving(true);
		try {
			const ok = await setNodeRoutingPreferences(target, nextPrefs);
			if (!current.current) {
				return;
			}
			sileo[ok ? "success" : "error"]({
				title: ok
					? "Routing preferences saved"
					: "Failed to save routing preferences",
				description: ok
					? "Managed requests will carry these preferences immediately. The fleet still enforces your organization's budget and guardrails."
					: "Core did not accept the change.",
			});
		} catch {
			if (!current.current) {
				return;
			}
			sileo.error({
				title: "Failed to save routing preferences",
				description: "Core did not accept the change.",
			});
		} finally {
			if (current.current) {
				pending.current = false;
				setSaving(false);
			}
		}
	};

	const openPricing = () => {
		void openExternal(`${FRONTEND_URL.replace(/\/$/, "")}/pricing#plans`).catch(
			() => undefined
		);
	};

	const setModelFallbacks = (values: string[]) => {
		setPrefs((current) => ({ ...current, openrouter_model_fallbacks: values }));
	};

	const updateAdvanced = (raw: string) => {
		setAdvancedDraft(raw);
		try {
			const options = parseOpenRouterOptions(raw);
			setPrefs((current) => ({ ...current, openrouter: options }));
			setAdvancedError(null);
		} catch (error) {
			setAdvancedError(
				error instanceof Error ? error.message : "Invalid OpenRouter options."
			);
		}
	};

	const controlsDisabled = !loaded || saving || Boolean(advancedError);

	return (
		<>
			{loadError ? (
				<SettingsCard className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-sm" role="alert">
						{loadError}
					</p>
					<Button onClick={() => void load()} size="sm" variant="outline">
						Retry routing preferences
					</Button>
				</SettingsCard>
			) : null}
			<SettingsSection
				caption="These preferences travel with this node's managed requests. The hosted fleet keeps the organization budget, provider allowlist, entitlement, and locked guardrails."
				title="Managed request routing"
			>
				<SettingsGroup>
					<SettingsItem
						description="Comma-separated gateway provider ids. The primary fleet route stays first; this only reorders eligible fallbacks."
						title="Preferred fallback providers"
					>
						<Input
							aria-label="Preferred fallback providers"
							autoComplete="off"
							disabled={!loaded || saving}
							onChange={(event) => setFallback(event.target.value)}
							placeholder="anthropic, openrouter, local"
							value={fallback}
						/>
					</SettingsItem>
					<SettingsItem
						bare
						description={
							<>
								Optional JSON array of additive rules with <code>kind</code>,{" "}
								<code>name</code>, and <code>regex</code>. Leave blank to clear.
							</>
						}
						title="Extra firewall rules"
					>
						<Textarea
							aria-label="Extra firewall rules JSON"
							className="min-h-32"
							disabled={!loaded || saving}
							onChange={(event) => setPatterns(event.target.value)}
							placeholder={
								'[{"kind":"secret","name":"internal_id","regex":"..."}]'
							}
							value={patterns}
							variant="code-caption"
						/>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Choose where OpenRouter sends managed requests, how it fails over, and which provider privacy and performance requirements apply."
				title="OpenRouter routing"
			>
				{businessOrg ? (
					<>
						<datalist id={PROVIDER_LIST_ID}>
							{providers.map((provider) => (
								<option key={provider.slug} value={provider.slug}>
									{provider.name}
								</option>
							))}
						</datalist>
						<SettingsGroup>
							<SettingsItem
								actions={
									<Select
										disabled={controlsDisabled}
										onValueChange={(value) => {
											if (value !== "custom") {
												changeOption(
													"sort",
													value === "default" ? undefined : value
												);
											}
										}}
										value={sortStrategy(providerOptions)}
									>
										<SelectTrigger
											aria-label="OpenRouter provider strategy"
											className="w-64"
											variant="default"
										>
											{sortStrategyLabel(sortStrategy(providerOptions))}
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="default">
												OpenRouter health-aware default
											</SelectItem>
											<SelectItem value="throughput">
												Higher throughput first
											</SelectItem>
											<SelectItem value="latency">
												Lower latency first
											</SelectItem>
											<SelectItem value="price">Lower price first</SelectItem>
											<SelectItem value="custom">
												Custom (advanced JSON)
											</SelectItem>
										</SelectContent>
									</Select>
								}
								description="The default uses OpenRouter's live provider health routing. A sort strategy or provider order replaces that default balancing behavior; choose one when you need a specific tradeoff."
								title="Provider strategy"
							/>
							<SettingsItem
								description="Provider slugs come from OpenRouter's public list. Enter any custom slug if it is not listed."
								title="Provider order"
							>
								<div className="space-y-2 pb-1">
									<OrderedProviderEditor
										disabled={controlsDisabled}
										onChange={(values) => changeProviderList("order", values)}
										providers={providers}
										values={stringList(providerOptions?.order)}
									/>
									{catalogError ? (
										<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
											<span>{catalogError}</span>
											<Button
												disabled={controlsDisabled}
												onClick={() => setCatalogReload((value) => value + 1)}
												size="sm"
												variant="outline"
											>
												Reload list
											</Button>
										</div>
									) : providers.length === 0 ? (
										<p className="text-muted-foreground text-xs">
											Loading OpenRouter providers…
										</p>
									) : null}
								</div>
							</SettingsItem>
						</SettingsGroup>
					</>
				) : (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button onClick={openPricing} size="sm" variant="outline">
									View Business plans
								</Button>
							}
							description={
								<>
									OpenRouter provider controls are available to Business
									organizations. Choose upstream providers, uptime and fallback
									behavior, ZDR, and other request-level routing requirements on
									the Business plan.
									{authenticated && billing.loading ? (
										<span className="mt-1 block">
											Checking the active organization's plan…
										</span>
									) : null}
								</>
							}
							title="Business plan required"
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			{businessOrg ? (
				<>
					<SettingsSection
						caption="When an allowlist is set, OpenRouter can only choose from those providers. Provider restrictions still apply alongside your organization's managed allowlist."
						title="Limit providers"
					>
						<SettingsCard className="grid gap-5 md:grid-cols-2">
							<ProviderListEditor
								disabled={controlsDisabled}
								label="Only these providers"
								onChange={(values) => changeProviderList("only", values)}
								providers={providers}
								values={stringList(providerOptions?.only)}
							/>
							<ProviderListEditor
								disabled={controlsDisabled}
								label="Never use these providers"
								onChange={(values) => changeProviderList("ignore", values)}
								providers={providers}
								values={stringList(providerOptions?.ignore)}
							/>
						</SettingsCard>
					</SettingsSection>

					<SettingsSection title="Fallback behavior">
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										aria-label="Allow provider fallbacks"
										checked={providerOptions?.allow_fallbacks !== false}
										disabled={controlsDisabled}
										onCheckedChange={(checked) =>
											changeOption(
												"allow_fallbacks",
												checked ? undefined : false
											)
										}
									/>
								}
								description="If a matching provider is unavailable, let OpenRouter try another provider that meets the same rules."
								title="Allow provider fallbacks"
							/>
							<SettingsItem
								description="OpenRouter tries these model ids after the primary model. Add them in preference order."
								title="Model fallbacks"
							>
								<div className="pb-1">
									<ModelFallbackEditor
										disabled={controlsDisabled}
										onChange={setModelFallbacks}
										values={prefs.openrouter_model_fallbacks}
									/>
								</div>
							</SettingsItem>
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						caption="Your organization's managed privacy policy can enforce stricter provider requirements."
						title="Privacy and data use"
					>
						<SettingsGroup>
							<SettingsItem
								actions={
									<Select disabled={true} value="deny">
										<SelectTrigger
											aria-label="OpenRouter data collection"
											className="w-72"
											variant="default"
										>
											{dataCollectionLabel("deny")}
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="default">
												OpenRouter default
											</SelectItem>
											<SelectItem value="allow">Allow collection</SelectItem>
											<SelectItem value="deny">
												Exclude data-collecting providers
											</SelectItem>
										</SelectContent>
									</Select>
								}
								description="Data-collecting providers are excluded for every plan."
								title="Data collection"
							/>
							<SettingsItem
								actions={
									<Switch
										aria-label="Require Zero Data Retention (ZDR)"
										checked={true}
										disabled={true}
										onCheckedChange={() => {}}
									/>
								}
								description="Required for every plan. OpenRouter requests use endpoints that meet its ZDR policy. Tools and plugins have separate policies."
								title="Require Zero Data Retention (ZDR)"
							/>
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection title="Provider requirements">
						<SettingsGroup>
							<SettingsItem
								actions={
									<Switch
										aria-label="Require parameter support"
										checked={providerOptions?.require_parameters === true}
										disabled={controlsDisabled}
										onCheckedChange={(checked) =>
											changeOption(
												"require_parameters",
												checked ? true : undefined
											)
										}
									/>
								}
								description="Only route to providers that support every parameter included in the request."
								title="Require parameter support"
							/>
							<SettingsItem
								actions={
									<Switch
										aria-label="Require distillable text"
										checked={providerOptions?.enforce_distillable_text === true}
										disabled={controlsDisabled}
										onCheckedChange={(checked) =>
											changeOption(
												"enforce_distillable_text",
												checked ? true : undefined
											)
										}
									/>
								}
								description="Only select providers that permit model distillation from text outputs."
								title="Require distillable text"
							/>
							<SettingsItem
								description="Leave all unchecked to let OpenRouter select any available precision."
								title="Quantization"
							>
								<div className="grid grid-cols-2 gap-x-4 gap-y-2 pb-1 sm:grid-cols-3 lg:grid-cols-4">
									{QUANTIZATIONS.map((quantization) => {
										const selected = stringList(
											providerOptions?.quantizations
										).includes(quantization);
										return (
											<label
												className="flex items-center gap-2 text-sm"
												key={quantization}
											>
												<Checkbox
													aria-label={`${quantization} quantization`}
													checked={selected}
													disabled={controlsDisabled}
													onCheckedChange={(checked) => {
														const values = stringList(
															providerOptions?.quantizations
														);
														const next = checked
															? [...values, quantization]
															: values.filter((item) => item !== quantization);
														changeOption(
															"quantizations",
															next.length ? next : undefined
														);
													}}
												/>
												{quantization}
											</label>
										);
									})}
								</div>
							</SettingsItem>
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						caption="These preferences help OpenRouter rank matching providers; they do not guarantee a latency or throughput level."
						title="Performance preferences"
					>
						<SettingsGroup>
							<PercentileEditor
								disabled={controlsDisabled}
								keyName="preferred_min_throughput"
								label="Preferred minimum throughput"
								onChange={changePercentile}
								unit="tokens per second"
								values={percentileValues(
									providerOptions,
									"preferred_min_throughput"
								)}
							/>
							<PercentileEditor
								disabled={controlsDisabled}
								keyName="preferred_max_latency"
								label="Preferred maximum latency"
								onChange={changePercentile}
								unit="seconds"
								values={percentileValues(
									providerOptions,
									"preferred_max_latency"
								)}
							/>
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						caption="Leave a limit blank to use the provider's price. These are OpenRouter request caps and use dollars."
						title="Maximum price"
					>
						<SettingsGroup>
							<PriceInput
								disabled={controlsDisabled}
								label="Prompt ($ per million tokens)"
								onChange={(raw) => changePrice("prompt", raw)}
								value={numericText(
									isRecord(providerOptions?.max_price)
										? optionNumber(providerOptions.max_price, "prompt")
										: undefined
								)}
							/>
							<PriceInput
								disabled={controlsDisabled}
								label="Completion ($ per million tokens)"
								onChange={(raw) => changePrice("completion", raw)}
								value={numericText(
									isRecord(providerOptions?.max_price)
										? optionNumber(providerOptions.max_price, "completion")
										: undefined
								)}
							/>
							<PriceInput
								disabled={controlsDisabled}
								label="Request ($ per request)"
								onChange={(raw) => changePrice("request", raw)}
								value={numericText(
									isRecord(providerOptions?.max_price)
										? optionNumber(providerOptions.max_price, "request")
										: undefined
								)}
							/>
							<PriceInput
								disabled={controlsDisabled}
								label="Image ($ per image)"
								onChange={(raw) => changePrice("image", raw)}
								value={numericText(
									isRecord(providerOptions?.max_price)
										? optionNumber(providerOptions.max_price, "image")
										: undefined
								)}
							/>
						</SettingsGroup>
					</SettingsSection>

					<SettingsSection
						caption="These controls require an active organization on the Business plan. Managed organization privacy rules take precedence when they are stricter than these routing preferences."
						title="Advanced provider options"
					>
						<SettingsCard>
							<details>
								<summary className="cursor-pointer text-sm">
									Edit complete OpenRouter provider JSON
								</summary>
								<p className="my-3 text-muted-foreground text-xs">
									All current and future fields from OpenRouter's{" "}
									<code>provider</code> request object can be set here. Typed
									controls stay in sync with this editor.
								</p>
								<Textarea
									aria-label="Advanced OpenRouter provider options JSON"
									className="min-h-44"
									disabled={!loaded || saving}
									maxLength={NODE_ROUTING_PREFS_MAX_BYTES}
									onChange={(event) => updateAdvanced(event.target.value)}
									placeholder="Leave blank to use the OpenRouter default routing."
									value={advancedText}
									variant="code-caption"
								/>
								{advancedError ? (
									<p className="mt-2 text-destructive text-xs">
										{advancedError}
									</p>
								) : null}
							</details>
						</SettingsCard>
					</SettingsSection>
				</>
			) : null}

			<SettingsSection>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button disabled={!loaded || saving} onClick={save} size="sm">
								{saving ? "Saving…" : "Save routing preferences"}
							</Button>
						}
						title={businessOrg ? "Saved for this organization" : "Save changes"}
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}

function ModelFallbackEditor({
	values,
	onChange,
	disabled,
}: {
	values: string[];
	onChange: (values: string[]) => void;
	disabled: boolean;
}) {
	const [candidate, setCandidate] = useState("");
	const add = () => {
		const model = candidate.trim();
		if (model && !values.includes(model)) {
			onChange([...values, model]);
		}
		setCandidate("");
	};
	return (
		<div className="space-y-2">
			<div className="flex min-w-0 gap-2">
				<Input
					aria-label="OpenRouter fallback model id"
					autoComplete="off"
					className="min-w-0"
					disabled={disabled}
					onChange={(event) => setCandidate(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
					placeholder="e.g. anthropic/claude-sonnet-4.6"
					value={candidate}
				/>
				<Button
					disabled={disabled || !candidate.trim()}
					onClick={add}
					size="sm"
				>
					Add model
				</Button>
			</div>
			{values.length > 0 ? (
				<ol className="divide-y divide-border/60">
					{values.map((model, index) => (
						<li
							className="flex flex-wrap items-center justify-between gap-2 py-1.5"
							key={`${model}-${index}`}
						>
							<span className="text-sm">
								<span className="mr-2 text-muted-foreground">{index + 1}.</span>
								<code>{model}</code>
							</span>
							<Button
								aria-label={`Remove fallback model ${model}`}
								disabled={disabled}
								onClick={() =>
									onChange(values.filter((item) => item !== model))
								}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

function PercentileEditor({
	keyName,
	label,
	unit,
	values,
	onChange,
	disabled,
}: {
	keyName: "preferred_min_throughput" | "preferred_max_latency";
	label: string;
	unit: string;
	values: PercentileValues;
	onChange: (
		key: "preferred_min_throughput" | "preferred_max_latency",
		percentile: Percentile,
		raw: string
	) => void;
	disabled: boolean;
}) {
	return (
		<SettingsItem
			title={
				<>
					{label}
					<span className="text-muted-foreground">{unit}</span>
				</>
			}
		>
			<div className="grid grid-cols-2 gap-3 pb-1 sm:grid-cols-4">
				{PERCENTILES.map((percentile) => (
					<label className="space-y-1 text-xs" key={percentile}>
						<span className="text-muted-foreground">{percentile}</span>
						<Input
							aria-label={`${label} ${percentile}`}
							disabled={disabled}
							min={0}
							onChange={(event) =>
								onChange(keyName, percentile, event.target.value)
							}
							placeholder="No preference"
							step="any"
							type="number"
							value={numericText(values[percentile])}
						/>
					</label>
				))}
			</div>
		</SettingsItem>
	);
}

/** One per-unit price cap, as a settings row (title left, field right). */
function PriceInput({
	label,
	value,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	return (
		<SettingsItem
			actions={
				<div>
					<Input
						aria-label={label}
						className="h-8 w-32"
						disabled={disabled}
						min={0}
						onChange={(event) => onChange(event.target.value)}
						placeholder="No cap"
						step="any"
						type="number"
						value={value}
					/>
				</div>
			}
			title={label}
		/>
	);
}

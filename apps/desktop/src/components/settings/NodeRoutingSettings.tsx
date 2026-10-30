import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
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
	openRouterOptionsSchema,
	serializeNodeRoutingPreferences,
	setNodeRoutingPreferences,
} from "@/src/lib/api/preferences.ts";
import { NodeRoutingBusinessSections } from "./NodeRoutingSettings-business-sections.tsx";
import { NodeRoutingOpenRouterSection } from "./NodeRoutingSettings-openrouter-section.tsx";
import {
	EMPTY_PATTERNS,
	formatOpenRouterOptions,
	isRecord,
	type Percentile,
	type ProviderListKey,
	parseOpenRouterOptions,
	parsePatterns,
	patternsText,
	percentileValues,
	withOption,
} from "./NodeRoutingSettings-options.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

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
	const tl = useLiteralMessages();
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
				description: tl(
					"Keep the saved settings under {maxBytes} bytes. Remove some provider entries or advanced options and try again.",
					{ maxBytes: NODE_ROUTING_PREFS_MAX_BYTES.toLocaleString() }
				),
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

			<NodeRoutingOpenRouterSection
				authenticated={authenticated}
				billing={billing}
				businessOrg={businessOrg}
				catalogError={catalogError}
				changeOption={changeOption}
				changeProviderList={changeProviderList}
				controlsDisabled={controlsDisabled}
				openPricing={openPricing}
				providerOptions={providerOptions}
				providers={providers}
				setCatalogReload={setCatalogReload}
			/>

			{businessOrg ? (
				<NodeRoutingBusinessSections
					advancedError={advancedError}
					advancedText={advancedText}
					changeOption={changeOption}
					changePercentile={changePercentile}
					changePrice={changePrice}
					changeProviderList={changeProviderList}
					controlsDisabled={controlsDisabled}
					loaded={loaded}
					prefs={prefs}
					providerOptions={providerOptions}
					providers={providers}
					saving={saving}
					setModelFallbacks={setModelFallbacks}
					updateAdvanced={updateAdvanced}
				/>
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

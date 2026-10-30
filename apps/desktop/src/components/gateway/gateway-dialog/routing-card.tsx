import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import { ProviderPoolsEditor } from "@/src/components/gateway/ProviderPoolsEditor.tsx";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import type {
	GatewayRoutingConfig,
	Modality,
	ProviderKind,
	ProviderPoolStrategy,
} from "@/src/lib/api/gateway.ts";
import {
	fetchGatewayConfig,
	routingViewIncludesModalityMap,
	updateGatewayConfig,
	withModalityMapping,
	withRoutingDraftEdits,
} from "@/src/lib/api/gateway.ts";
import { ModalityRoutingRows } from "./modality-routing-rows.tsx";
import {
	type ModelMappingFormState,
	mappingFromForm,
	NON_CHAT_POOL_PROVIDERS,
	PROVIDER_LABELS,
} from "./model-mapping-dialog.tsx";
import { RoutingDefaultProviderSection } from "./routing-default-provider-section.tsx";
import { RoutingFallbackChainSection } from "./routing-fallback-chain-section.tsx";
import { RoutingModelMappingsSection } from "./routing-model-mappings-section.tsx";

export function RoutingCard({
	target,
	reachable,
	configuredProviders,
	canConfigure,
}: {
	target: ApiTarget;
	reachable: boolean;
	configuredProviders: string[];
	/** When false the caller lacks `gateway.configure`; controls read-only. */
	canConfigure: boolean;
}) {
	const [config, setConfig] = useState<GatewayRoutingConfig | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [configReadAttempt, setConfigReadAttempt] = useState(0);
	const [draft, setDraft] = useState<GatewayRoutingConfig | null>(null);
	const [supportedPoolStrategies, setSupportedPoolStrategies] = useState<
		ProviderPoolStrategy[] | undefined
	>();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveOk, setSaveOk] = useState(false);
	const [mappingError, setMappingError] = useState<string | null>(null);

	const providers: ProviderKind[] = configuredProviders.filter(
		(p): p is ProviderKind => p in PROVIDER_LABELS
	);
	const poolProviders = configuredProviders.filter(
		(provider) => !NON_CHAT_POOL_PROVIDERS.has(provider)
	);
	const poolAliases = Object.keys(draft?.provider_pools ?? {}).map(
		(name) => `pool:${name}`
	);
	const mappingProviders = [
		...configuredProviders.filter((provider) => provider !== "classify"),
		...poolAliases,
	];

	useEffect(() => {
		if (!reachable || config !== null) {
			return;
		}
		let cancelled = false;
		fetchGatewayConfig(target)
			.then((cfg) => {
				if (!cancelled) {
					setConfig(cfg.routing);
					setDraft(cfg.routing);
					setSupportedPoolStrategies(cfg.strategyCapabilities?.chat);
					setConfigError(null);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setConfigError(
						e instanceof Error ? e.message : "Failed to load routing config"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reachable, config, configReadAttempt, target]);

	/**
	 * Save the draft's default provider, fallback chain and cost tiers. Like the
	 * row savers below, the body is rebuilt from a fresh `GET` (only the fields
	 * this draft changed since it loaded are applied) and carries that read's
	 * revision, so Smart Routing, eval routing or tier edits saved elsewhere are
	 * kept, and a concurrent write surfaces as a conflict instead of a revert.
	 */
	const handleSave = async () => {
		if (!(draft && config)) {
			return;
		}
		setSaving(true);
		setSaveError(null);
		setSaveOk(false);
		try {
			const cfg = await fetchGatewayConfig(target);
			const next = withRoutingDraftEdits(cfg.routing, config, draft);
			await updateGatewayConfig(target, {
				routing: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setConfig(next);
			setDraft(next);
			setSaveOk(true);
			setTimeout(() => setSaveOk(false), 3000);
		} catch (e) {
			setSaveError(
				e instanceof ApiError && e.status === 409
					? "Routing changed elsewhere while saving. Save again to apply your edits on top of it."
					: e instanceof Error
						? e.message
						: "Failed to save routing config"
			);
		} finally {
			setSaving(false);
		}
	};

	const patchDraft = (patch: Partial<GatewayRoutingConfig>) => {
		setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
		setSaveOk(false);
		setSaveError(null);
	};

	const addMapping = async (form: ModelMappingFormState) => {
		const cfg = await fetchGatewayConfig(target);
		const mapping = mappingFromForm(form);
		const next: GatewayRoutingConfig = {
			...cfg.routing,
			model_map: { ...cfg.routing.model_map, [form.model.trim()]: mapping },
		};
		await updateGatewayConfig(target, {
			routing: next,
			expectedRevision: cfg.configRevision ?? undefined,
		});
		setConfig(next);
		setDraft(next);
	};

	const removeMapping = async (model: string) => {
		setMappingError(null);
		try {
			const cfg = await fetchGatewayConfig(target);
			const model_map = { ...cfg.routing.model_map };
			delete model_map[model];
			const next: GatewayRoutingConfig = { ...cfg.routing, model_map };
			await updateGatewayConfig(target, {
				routing: next,
				expectedRevision: cfg.configRevision ?? undefined,
			});
			setConfig(next);
			setDraft(next);
		} catch (e) {
			setMappingError(
				e instanceof Error ? e.message : "Failed to remove model mapping."
			);
		}
	};

	/**
	 * Author or clear one `modality_map` row. Same read-modify-write shape as
	 * {@link addMapping}/{@link removeMapping} above, and for the same two
	 * reasons: `PUT /v1/config { routing }` replaces the section wholesale, and
	 * the gateway persists routing WITHOUT updating its startup snapshot — so the
	 * body has to be built from a fresh `GET`, not from `draft`, or this save
	 * spreads stale values back over the file.
	 *
	 * `withModalityMapping` does the spread, which is what carries `eval_routing`,
	 * `smart_routing`, `provider_tiers` and the rest through untouched.
	 *
	 * Inherited from that shape, and worth stating rather than discovering: the
	 * re-seeded `draft` is server state, so an UNSAVED edit to the default
	 * provider or fallback chain sitting in the draft is discarded by this save.
	 * The model-map rows have always behaved this way; the two row editors and the
	 * draft-plus-Save controls are deliberately not merged, because merging them
	 * would mean a row edit could also commit a half-finished chain reorder.
	 */
	const saveModalityMapping = async (
		modality: Modality,
		mapping: { model?: string; provider: string } | null
	) => {
		const cfg = await fetchGatewayConfig(target);
		const next = withModalityMapping(cfg.routing, modality, mapping);
		await updateGatewayConfig(target, {
			routing: next,
			expectedRevision: cfg.configRevision ?? undefined,
		});
		setConfig(next);
		setDraft(next);
	};

	const saveProviderPool = async (
		name: string,
		pool: NonNullable<GatewayRoutingConfig["provider_pools"]>[string] | null
	) => {
		const cfg = await fetchGatewayConfig(target);
		if (cfg.routing.provider_pools === undefined) {
			throw new Error("This Gateway does not report named provider pools.");
		}
		setSupportedPoolStrategies(cfg.strategyCapabilities?.chat);
		const provider_pools = { ...cfg.routing.provider_pools };
		if (pool) {
			provider_pools[name] = pool;
		} else {
			const alias = `pool:${name}`;
			if (
				Object.values(cfg.routing.model_map).some(
					(mapping) => mapping.provider === alias
				)
			) {
				throw new Error(`Remove model mappings to ${alias} first.`);
			}
			delete provider_pools[name];
		}
		const next: GatewayRoutingConfig = { ...cfg.routing, provider_pools };
		await updateGatewayConfig(target, {
			routing: next,
			expectedRevision: cfg.configRevision ?? undefined,
		});
		setConfig(next);
		setDraft(next);
	};

	const moveFallback = (index: number, direction: "up" | "down") => {
		if (!draft) {
			return;
		}
		const chain = [...draft.fallback_chain];
		const swapIndex = direction === "up" ? index - 1 : index + 1;
		if (swapIndex < 0 || swapIndex >= chain.length) {
			return;
		}
		const tmp = chain[index];
		chain[index] = chain[swapIndex];
		chain[swapIndex] = tmp;
		patchDraft({ fallback_chain: chain });
	};

	const addFallback = (provider: ProviderKind) => {
		if (!draft) {
			return;
		}
		if (draft.fallback_chain.includes(provider)) {
			return;
		}
		patchDraft({ fallback_chain: [...draft.fallback_chain, provider] });
	};

	// `fallback_chain` holds open `ProviderId` registry ids, not only `ProviderKind`.
	const removeFallback = (provider: string) => {
		if (!draft) {
			return;
		}
		patchDraft({
			fallback_chain: draft.fallback_chain.filter((p) => p !== provider),
		});
	};

	const isDisabled = !reachable || draft === null || !canConfigure;
	const mappingEntries = Object.entries(draft?.model_map ?? {});
	// Presence is read off `config` — the last thing the NODE actually said —
	// rather than off `draft`, which is that same object plus local edits.
	//
	// THREE states, not two, and the third is why this is a `null` and not a
	// boolean: `config === null` covers both "gateway unreachable" (the fetch
	// effect returns early on `!reachable`) and "fetch still in flight", neither
	// of which says anything about what the node serves. Collapsing either into
	// "not served" would flash a warning accusing a healthy, current gateway of
	// being about to drop its modality map every time this dialog opens.
	const modalityMapServed =
		config === null ? null : routingViewIncludesModalityMap(config);
	// Coalesce only at the render site — never in `fetchGatewayConfig`, which
	// would erase the difference between "not served" and "served, empty".
	const modalityMap = draft?.modality_map ?? {};

	return (
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<RoutingDefaultProviderSection
				configError={configError}
				draft={draft}
				isDisabled={isDisabled}
				onRetry={() => setConfigReadAttempt((attempt) => attempt + 1)}
				patchDraft={patchDraft}
				providers={providers}
				reachable={reachable}
			/>

			<RoutingModelMappingsSection
				addMapping={addMapping}
				isDisabled={isDisabled}
				mappingEntries={mappingEntries}
				mappingError={mappingError}
				mappingProviders={mappingProviders}
				onRoutingSaved={(next) => {
					setConfig(next);
					setDraft(next);
				}}
				poolAliases={poolAliases}
				removeMapping={removeMapping}
				target={target}
			/>

			{draft?.provider_pools === undefined ? null : (
				<ProviderPoolsEditor
					disabled={isDisabled}
					modelMap={draft.model_map}
					onSave={saveProviderPool}
					pools={draft.provider_pools}
					providers={poolProviders}
					supportedStrategies={supportedPoolStrategies}
				/>
			)}

			{modalityMapServed === null ? null : (
				<SettingsSection
					caption={
						<CaptionInfo
							detail={
								"Consulted BEFORE the model mappings above for any non-chat request, so this is the swap point for media providers such as fal, Replicate and Modal. A per-agent slot forwarded by Core still outranks it. Each row saves immediately."
							}
						>
							{"Which provider serves image, speech and video requests."}
						</CaptionInfo>
					}
					title="Modality routing"
				>
					<ModalityRoutingRows
						configuredProviders={configuredProviders}
						defaultProvider={draft?.default_provider ?? "openai"}
						disabled={isDisabled}
						modalityMap={modalityMap}
						onSave={saveModalityMapping}
						served={modalityMapServed}
					/>
				</SettingsSection>
			)}

			<RoutingFallbackChainSection
				addFallback={addFallback}
				draft={draft}
				isDisabled={isDisabled}
				moveFallback={moveFallback}
				patchDraft={patchDraft}
				providers={providers}
				removeFallback={removeFallback}
			/>

			<div className="flex flex-wrap items-center gap-3 px-3">
				<Button
					disabled={isDisabled || draft === config}
					loading={saving}
					onClick={() => handleSave()}
					size="sm"
					variant="outline"
				>
					Save
				</Button>
				{saveOk ? (
					<span className="text-sm text-status-success">
						Saved. Gateway will apply on next restart.
					</span>
				) : null}
				{saveError ? (
					<span className="text-sm text-status-destructive">{saveError}</span>
				) : null}
			</div>
		</div>
	);
}

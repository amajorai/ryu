// apps/desktop/src/components/agents/RyuPiConfig.tsx
//
// Thin container for the Ryu-managed Pi agent's model + provider editor. The
// presentational layer is `@ryu/blocks/desktop/agent-edit#RyuPiConfigView`; this
// owns the `usePiConfig` query/mutation state and the form-local fields, and
// derives the props the view renders. Backed by Core's `/api/pi-config`
// endpoints — every routing/credential decision lives in Core.
//
// Two routing modes, chosen via the provider dropdown:
//   - "Ryu Gateway (governed)" → every model call routes through the Gateway
//     (firewall / budget / audit). No provider key is stored in Pi config.
//   - any other provider → Pi talks directly to that provider (a deliberate
//     egress bypass); an api-key credential is stored in the isolated auth.json.

import { RyuPiConfigView } from "@ryu/blocks/desktop/agent-edit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { groupModelItems } from "@/components/agent-elements/input/model-groups.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getActiveModel,
	listInstalledModels,
	setActiveModel,
} from "@/src/lib/api/models.ts";
import { discoverModels } from "@/src/lib/api/pi-config.ts";

/** Sentinel option id for defining a brand-new custom OpenAI-compatible provider. */
const CUSTOM_PROVIDER_ID = "__custom__";
/** Sentinel for "use the provider default" thinking level. */
const THINKING_DEFAULT = "";

export function RyuPiConfig() {
	const { config, catalog, loading, error, saving, saveError, save } =
		usePiConfig();

	// Installed/active local model — the ready-to-pick option for gateway routing
	// (the served-model stem the Gateway routes to), surfaced as a dropdown choice.
	const activeNode = useActiveNode();
	const activeModelQuery = useQuery({
		queryKey: ["models", "active", activeNode.url],
		queryFn: () =>
			getActiveModel({ url: activeNode.url, token: activeNode.token ?? null }),
	});

	// Locally fine-tuned (merged) models, offered as ready-to-pick gateway models.
	// The local engine serves one model at a time, so choosing one also makes it
	// the active served model (below) — that is how the gateway routes to it.
	const qc = useQueryClient();
	const installedModelsQuery = useQuery({
		queryKey: ["models", "installed", activeNode.url],
		queryFn: () =>
			listInstalledModels({
				url: activeNode.url,
				token: activeNode.token ?? null,
			}),
	});
	const installedStems = useMemo(
		() => (installedModelsQuery.data ?? []).map((m) => m.stem).filter(Boolean),
		[installedModelsQuery.data]
	);
	const setActiveMutation = useMutation({
		mutationFn: (stem: string) =>
			setActiveModel(
				{ url: activeNode.url, token: activeNode.token ?? null },
				stem
			),
		onSuccess: (res) => {
			sileo.success({ title: `Now serving ${res.active}` });
			qc.invalidateQueries({
				queryKey: ["models", "active", activeNode.url],
			}).catch(() => undefined);
		},
		onError: (e) => {
			sileo.error({
				title: e instanceof Error ? e.message : "Could not switch model",
			});
		},
	});

	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState(THINKING_DEFAULT);
	const [apiKey, setApiKey] = useState("");
	const [customId, setCustomId] = useState("");
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [customApi, setCustomApi] = useState("openai-completions");
	const [saved, setSaved] = useState(false);
	const target = useMemo(() => toTarget(activeNode), [activeNode]);

	// Hydrate the form from the loaded config once it arrives.
	useEffect(() => {
		if (!config) {
			return;
		}
		setProvider(config.provider);
		setModel(config.model ?? "");
		setThinkingLevel(config.thinkingLevel ?? THINKING_DEFAULT);
	}, [config]);

	const providers = catalog?.providers ?? [];
	const isCustomNew = provider === CUSTOM_PROVIDER_ID;
	const selectedMeta = useMemo(
		() => providers.find((p) => p.id === provider) ?? null,
		[providers, provider]
	);
	const routing = isCustomNew
		? "direct"
		: (selectedMeta?.routing ?? config?.routing ?? "gateway");
	const showApiKey = isCustomNew || selectedMeta?.authKind === "api-key";
	const discoveryProvider = isCustomNew ? customId.trim() : provider;

	const discoveredQuery = useQuery({
		queryKey: [
			"pi-config-discover",
			activeNode.url,
			discoveryProvider,
			routing,
			isCustomNew ? customApi : null,
		],
		queryFn: () =>
			discoverModels(target, {
				provider: discoveryProvider || null,
				baseUrl: isCustomNew ? customBaseUrl.trim() || null : null,
				api: isCustomNew ? customApi : null,
			}),
		enabled: Boolean(discoveryProvider) && !loading,
		staleTime: 60_000,
	});

	const providerItems = useMemo(
		() => [
			...providers.map((p) => ({ id: p.id, label: p.label })),
			{
				id: CUSTOM_PROVIDER_ID,
				label: "Custom (OpenAI / Anthropic-compatible)…",
			},
		],
		[providers]
	);
	const thinkingItems = useMemo(
		() => [
			{ id: THINKING_DEFAULT, label: "Provider default" },
			...(catalog?.thinkingLevels ?? []).map((l) => ({ id: l, label: l })),
		],
		[catalog?.thinkingLevels]
	);
	const apiTypeItems = useMemo(
		() =>
			(catalog?.apiTypes ?? ["openai-completions"]).map((a) => ({
				id: a,
				label: a,
			})),
		[catalog?.apiTypes]
	);

	// Dropdown options: discovered provider models + installed local stems (gateway)
	// + suggestions + current value. Grouped by provider for the searchable picker.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
	const modelOptions = useMemo(() => {
		const active = activeModelQuery.data;
		const discovered = discoveredQuery.data?.models ?? [];
		const items: { id: string; name: string }[] = [];
		const seen = new Set<string>();
		const push = (id: string, name?: string) => {
			if (!id || seen.has(id)) {
				return;
			}
			seen.add(id);
			items.push({ id, name: name ?? id });
		};

		if (routing === "gateway") {
			if (active?.active) {
				push(active.active);
			}
			if (active?.default && active.default !== active.active) {
				push(active.default);
			}
			for (const stem of installedStems) {
				push(stem);
			}
		}

		for (const m of discovered) {
			push(m.id, m.name ?? m.id);
		}
		for (const m of selectedMeta?.suggestedModels ?? []) {
			push(m);
		}
		if (model) {
			push(model);
		}

		return groupModelItems(items);
	}, [
		activeModelQuery.data,
		discoveredQuery.data?.models,
		installedStems,
		model,
		routing,
		selectedMeta?.suggestedModels,
	]);

	// Picking a locally installed model also serves it (gateway routes to the
	// active served model), so the agent actually talks to the chosen weights.
	const handleModelChange = (value: string) => {
		setModel(value);
		if (routing === "gateway" && installedStems.includes(value)) {
			setActiveMutation.mutate(value);
		}
	};

	const canSave =
		!saving &&
		provider !== "" &&
		(!isCustomNew || (customId.trim() !== "" && customBaseUrl.trim() !== ""));

	async function onSave() {
		setSaved(false);
		await save({
			provider: isCustomNew ? customId.trim() : provider,
			model: model.trim() || null,
			thinkingLevel: thinkingLevel || null,
			apiKey: apiKey.trim() || null,
			baseUrl: isCustomNew ? customBaseUrl.trim() : null,
			api: isCustomNew ? customApi : null,
		});
		setApiKey("");
		setSaved(true);
	}

	return (
		<RyuPiConfigView
			apiKey={apiKey}
			apiTypeItems={apiTypeItems}
			canSave={canSave}
			configDir={config?.configDir}
			customApi={customApi}
			customBaseUrl={customBaseUrl}
			customId={customId}
			error={error}
			isCustomNew={isCustomNew}
			loading={loading}
			model={model}
			modelOptions={modelOptions}
			modelsLoading={discoveredQuery.isFetching}
			onApiKeyChange={setApiKey}
			onCustomApiChange={setCustomApi}
			onCustomBaseUrlChange={setCustomBaseUrl}
			onCustomIdChange={setCustomId}
			onModelChange={handleModelChange}
			onProviderChange={setProvider}
			onSave={() => {
				onSave().catch(() => undefined);
			}}
			onThinkingLevelChange={(v) => setThinkingLevel(v || THINKING_DEFAULT)}
			provider={provider}
			providerItems={providerItems}
			routing={routing}
			saved={saved}
			saveError={saveError}
			saving={saving}
			selectedMeta={selectedMeta}
			showApiKey={showApiKey}
			thinkingItems={thinkingItems}
			thinkingLevel={thinkingLevel}
		/>
	);
}

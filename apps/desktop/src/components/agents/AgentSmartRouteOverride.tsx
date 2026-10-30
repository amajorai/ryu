// apps/desktop/src/components/agents/AgentSmartRouteOverride.tsx
//
// Per-agent Plane A override (the "both" config scope): give ONE agent its own
// model-routing rules that replace the gateway's global smart_routing for that
// agent's requests. Writes a per-agent SmartRoutingConfig to the gateway config
// (`routing.smart_routing.agent_routes[<agentId>]`); the gateway applies it by the
// request's trust-bound agent id, so it reaches gateway-routed ACP agents as well
// as OpenAI-compatible ones. Off (the master switch) clears the override, so the
// agent falls back to the global router.
//
// Overrides used to live in the `agent-smart-route` Core preference, which Core
// injects as `ryu_smart_route` only on its OpenAI-compatible forward path, so they
// never reached ACP agents. A legacy entry is still loaded as the starting draft,
// and saving moves it to the gateway and removes the Core copy (Core's request
// field would otherwise keep winning for the agents it does reach).

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	classifyTierCannotServeModel,
	DEFAULT_SMART_ROUTING,
	type ModelRouterType,
	routeStrategyCopy,
	type SmartRoutingConfig,
	saveAgentRouteOverride,
} from "@/src/lib/api/gateway.ts";
import { setAgentSmartRoute } from "@/src/lib/api/preferences.ts";
import {
	ClassifyTierNote,
	useClassifyTier,
} from "./AgentSmartRouteOverride-classify-tier.tsx";
import {
	buildSmartRoutingConfig,
	loadOverride,
	type RuleRow,
	SAVE_FAILED_COPY,
	saveErrorCopy,
} from "./AgentSmartRouteOverride-load.ts";
import {
	EmbeddingFields,
	EscalationFields,
	RandomSeedField,
	StageRouterFields,
} from "./AgentSmartRouteOverride-router-fields.tsx";
import { RulesSection } from "./AgentSmartRouteOverride-rules.tsx";
import {
	RouterTypeField,
	StrategyField,
} from "./AgentSmartRouteOverride-type-fields.tsx";

export function AgentSmartRouteOverride({ agentId }: { agentId: string }) {
	const node = useActiveNode();
	// The app-wide "Friendly names" toggle picks which of the two vocabularies this
	// picker speaks. Read per-surface rather than threaded through props: all three
	// places that render this control now share one copy table, so each just asks.
	const [friendly] = useFriendlyMode();
	const strategyCopy = routeStrategyCopy(friendly);
	const tl = useLiteralMessages();
	/**
	 * The one copy for "on, with no classifier picked". Informational, not a
	 * warning: the gateway's `de_classifier_model` resolves a blank to the classify
	 * tier's id, so the feature runs on the local classifier rather than not at all.
	 *
	 * This used to read "…so it never runs, and every request keeps the model it
	 * asked for", which was true of the old plain `#[serde(default)] String` and
	 * became false the moment the field gained its deserializer. Kept as one
	 * constant, shared with nothing else here, so it cannot drift from the gateway
	 * card's wording again without someone noticing both.
	 */
	const classifierDefaultedCopy = tl(
		"No classifier model is picked, so smart routing uses this node's local classifier ({model}). Enter a model id to route with something else.",
		{ model: CLASSIFY_MODEL_ID }
	);
	const [enabled, setEnabled] = useState(false);
	const [draft, setDraft] = useState<SmartRoutingConfig>(DEFAULT_SMART_ROUTING);
	const [rules, setRules] = useState<RuleRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [legacyPresent, setLegacyPresent] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// Keyed on the node's OWN identity, not on a getter. `useActiveNodeGetter`
	// closes over the store's `getActiveNode`, which is a stable reference — it
	// does not change when the active node does — so memoising on `[getNode]`
	// froze `target` at whatever node was active when this first rendered, and a
	// subsequent node switch left the probes, the load and the save addressing the
	// old box. `useActiveNode` subscribes instead, and the deps are the two
	// primitives `toTarget` actually reads.
	const target = useMemo(
		() => toTarget(node),
		// the two fields
		// toTarget reads are the identity that matters; depending on `node` itself
		// would re-run on every unrelated store write.
		[node.url, node.token]
	);
	const classifyTier = useClassifyTier(target, enabled);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		setLoadFailed(false);
		loadOverride(target, agentId)
			.then(({ config: cfg, legacy }) => {
				if (cancelled) {
					return;
				}
				setLegacyPresent(legacy);
				setEnabled(cfg !== null);
				const base = cfg ?? DEFAULT_SMART_ROUTING;
				setDraft(base);
				setRules(
					base.rules.map((r) => ({
						id: crypto.randomUUID(),
						description: r.description,
						model: r.model,
						weight: String(r.weight ?? 1),
					}))
				);
			})
			.catch(() => {
				if (!cancelled) {
					setLoadFailed(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoaded(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, loadAttempt, target]);

	// The two states in which this override is enabled and yet inert, both of which
	// the router treats as a no-op WITHOUT saying so (`SmartRoutingConfig::is_active`
	// returns false and the turn keeps the model it asked for). Here that is worse
	// than a no-op: the override's mere presence also skips the GLOBAL router that
	// would otherwise have run, so an inert override disables routing outright.
	//
	//  - a blank classifier model is NOT one of them any more.
	//    `de_classifier_model` in the gateway resolves a blank to the classify
	//    tier's id as the config comes off the wire, so a cleared box means "use
	//    the local classifier", not "off". It IS reported, as a plain default
	//    rather than a warning.
	//  - a classifier model served only by the local classify tier on a node that
	//    cannot serve it — either no such tier at all, or (the reachable case) the
	//    tier's weights were never downloaded so its sidecar can never start. The
	//    classification call errors, and smart routing fails open by design. This
	//    is the live one, and the blank now lands straight on it by default.
	const classifierModel = draft.classifier_model.trim();
	const routerType: ModelRouterType = draft.router_type ?? "llm_classifier";
	const smartLlm =
		enabled &&
		routerType === "llm_classifier" &&
		(draft.strategy ?? "llm") === "llm";
	const classifierDefaulted = smartLlm && classifierModel === "";
	// Probe what the gateway will RESOLVE to, not what the box holds — an empty
	// string never matches the classify-tier prefix, so probing the raw value
	// would skip the warning in exactly the cleared-box case that now needs it.
	const resolvedClassifier = classifierModel || CLASSIFY_MODEL_ID;
	const classifierUnserved =
		smartLlm && classifyTierCannotServeModel(classifyTier, resolvedClassifier);
	const classifierUnservedReason =
		classifyTier === "absent" || classifyTier === "unweighted"
			? CLASSIFY_TIER_COPY[classifyTier].reason
			: null;
	const classifierUnservedCopy = tl(
		"Smart routing is on with the local classify tier as its classifier, but {reason}, so the classification call will fail and every request will quietly keep the model it asked for. Pick a model this node can reach.",
		{ reason: String(classifierUnservedReason) }
	);

	const patch = (p: Partial<SmartRoutingConfig>) => {
		setSaveError(null);
		setDraft((prev) => ({ ...prev, ...p }));
	};

	const updateRule = (
		id: string,
		field: "description" | "model" | "weight",
		value: string
	) => {
		setSaveError(null);
		setRules((prev) =>
			prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
		);
	};

	const addRule = () => {
		setSaveError(null);
		setRules((prev) => [
			...prev,
			{ id: crypto.randomUUID(), description: "", model: "", weight: "1" },
		]);
	};

	const removeRule = (id: string) => {
		setSaveError(null);
		setRules((prev) => prev.filter((r) => r.id !== id));
	};

	const handleSave = async () => {
		setSaving(true);
		setSaveError(null);
		let ok = false;
		try {
			if (enabled) {
				const config = buildSmartRoutingConfig(draft, rules);
				await saveAgentRouteOverride(target, agentId, config);
			} else {
				await saveAgentRouteOverride(target, agentId, null);
			}
			// Retire the legacy Core copy; left in place, Core's request field
			// would keep overriding the gateway entry for OpenAI-compat chat.
			ok = legacyPresent
				? await setAgentSmartRoute(target, agentId, null)
				: true;
			if (ok) {
				setLegacyPresent(false);
			}
		} catch (error) {
			setSaveError(saveErrorCopy(error));
			sileo.error({ title: "Failed to save per-agent routing" });
			return;
		} finally {
			setSaving(false);
		}
		if (!ok) {
			setSaveError(SAVE_FAILED_COPY);
			sileo.error({ title: "Failed to save per-agent routing" });
			return;
		}
		// The save succeeded, so the toast must report what was actually stored. A
		// green "now routes by its own rules" over a config the router will refuse to
		// activate is the whole reported bug: the setting persists, the toast reads
		// fine, and every turn keeps the model it asked for — with the global router
		// suppressed on top.
		// Only the UNSERVED case still warns. A blank classifier resolves to the
		// local tier in the gateway, so warning about it here would send the user
		// hunting for a fault that is not there.
		if (classifierUnserved) {
			sileo.warning({
				title: "Per-agent routing saved, but it will not run",
				description: classifierUnservedCopy,
			});
			return;
		}
		sileo.success({
			title: enabled
				? "Per-agent routing saved"
				: "Per-agent routing override cleared",
			description: enabled
				? "This agent's chat now routes by its own rules."
				: undefined,
		});
	};

	if (!loaded) {
		return <SkeletonRows spacing="generous" />;
	}
	if (loadFailed) {
		return (
			<div className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-4">
				<p className="text-sm text-status-destructive" role="alert">
					Could not load per-agent routing. Check this node's connection or
					permissions and retry.
				</p>
				<div>
					<Button
						onClick={() => {
							setLoaded(false);
							setLoadAttempt((attempt) => attempt + 1);
						}}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<Label htmlFor="agent-smart-route-enabled">
						Override model routing for this agent
					</Label>
					<p className="text-detail text-muted-foreground">
						Replaces the global smart routing for this agent. Off uses the
						global router.
					</p>
				</div>
				<Switch
					checked={enabled}
					id="agent-smart-route-enabled"
					onCheckedChange={(nextEnabled) => {
						setSaveError(null);
						setEnabled(nextEnabled);
					}}
				/>
			</div>

			{enabled ? (
				<>
					<RouterTypeField patch={patch} routerType={routerType} />

					{routerType === "llm_classifier" ? (
						<StrategyField
							draft={draft}
							friendly={friendly}
							patch={patch}
							strategyCopy={strategyCopy}
						/>
					) : null}

					{routerType === "llm_classifier" &&
					(draft.strategy ?? "llm") === "llm" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-smart-route-classifier">
								Classifier model
							</Label>
							<Input
								id="agent-smart-route-classifier"
								onChange={(e) => patch({ classifier_model: e.target.value })}
								placeholder="e.g. gpt-4o-mini, or a local model"
								value={draft.classifier_model}
							/>
							<p className="text-detail text-muted-foreground">
								A cheap, fast model used only to sort requests.
							</p>
							{classifierDefaulted ? (
								<p className="text-muted-foreground text-xs">
									{classifierDefaultedCopy}
								</p>
							) : null}
							{classifierUnserved ? (
								<p className="text-status-destructive text-xs">
									{classifierUnservedCopy}
								</p>
							) : null}
							<ClassifyTierNote
								onUse={() => patch({ classifier_model: CLASSIFY_MODEL_ID })}
								state={classifyTier}
								value={draft.classifier_model}
							/>
						</div>
					) : null}

					{routerType === "llm_classifier" && draft.strategy === "embedding" ? (
						<EmbeddingFields draft={draft} patch={patch} />
					) : null}

					{routerType === "random" ? (
						<RandomSeedField draft={draft} patch={patch} />
					) : null}

					{routerType === "stage_router" ? (
						<StageRouterFields draft={draft} patch={patch} />
					) : null}

					{routerType === "escalation" ? (
						<EscalationFields draft={draft} patch={patch} />
					) : null}

					{routerType === "llm_classifier" || routerType === "random" ? (
						<>
							<RulesSection
								addRule={addRule}
								removeRule={removeRule}
								routerType={routerType}
								rules={rules}
								updateRule={updateRule}
							/>

							{routerType === "llm_classifier" ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="agent-smart-route-default">
										Default model when no rule matches
									</Label>
									<Input
										id="agent-smart-route-default"
										onChange={(e) => patch({ default_model: e.target.value })}
										placeholder="Leave blank to keep the originally requested model"
										value={draft.default_model ?? ""}
									/>
								</div>
							) : null}
						</>
					) : null}
				</>
			) : null}

			{saveError ? (
				<p className="text-sm text-status-destructive" role="alert">
					{saveError}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button loading={saving} onClick={() => handleSave()} size="sm">
					Save
				</Button>
			</div>
		</div>
	);
}

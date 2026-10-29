import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
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

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { ApiError, type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	type ClassifyTierState,
	classifyTierCannotServeModel,
	classifyTierServable,
	DEFAULT_SMART_ROUTING,
	deriveClassifyTierState,
	fetchAgentRouteOverride,
	fetchClassifyWeightsPresent,
	MODEL_ROUTER_TYPE_DESCRIPTIONS,
	MODEL_ROUTER_TYPE_LABELS,
	type ModelRouterType,
	type RouteStrategy,
	routeStrategyCopy,
	type SmartRoutingConfig,
	SmartRoutingUnavailableError,
	type StagePicker,
	saveAgentRouteOverride,
} from "@/src/lib/api/gateway.ts";
import {
	getAgentSmartRoute,
	setAgentSmartRoute,
} from "@/src/lib/api/preferences.ts";
import { fetchSidecarStatus } from "@/src/lib/api/system.ts";

interface RuleRow {
	description: string;
	id: string;
	model: string;
	weight: string;
}

// Same cadences the gateway's Smart routing card polls at: the run state flips
// whenever the lazy sidecar starts, the weights land once after a download.
const CLASSIFY_STATUS_POLL_MS = 5000;
const CLASSIFY_WEIGHTS_POLL_MS = 30_000;

const SAVE_FAILED_COPY =
	"The save failed. Your draft is still here; check the connection and retry.";

/**
 * The agent's override as stored on the gateway, else its legacy Core
 * preference entry (see the module comment). `legacy` says whether a Core copy
 * exists that saving must retire.
 */
async function loadOverride(
	target: ApiTarget,
	agentId: string
): Promise<{ config: SmartRoutingConfig | null; legacy: boolean }> {
	const [stored, legacy] = await Promise.all([
		fetchAgentRouteOverride(target, agentId),
		// An unreadable legacy preference must not hide the gateway's entry.
		getAgentSmartRoute(target, agentId).catch(() => null),
	]);
	return { config: stored ?? legacy, legacy: legacy !== null };
}

function saveErrorCopy(error: unknown): string {
	if (error instanceof SmartRoutingUnavailableError) {
		return "This node's gateway does not report smart routing, so it cannot store a per-agent override. Update the node to use this setting.";
	}
	if (error instanceof ApiError && error.status === 403) {
		return "This node denied the change. Per-agent routing needs the gateway.configure permission. Your draft is still here.";
	}
	return SAVE_FAILED_COPY;
}

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
const CLASSIFIER_DEFAULTED_COPY = `No classifier model is picked, so smart routing uses this node's local classifier (${CLASSIFY_MODEL_ID}). Enter a model id to route with something else.`;

/**
 * Live state of the local classify tier on the node this override is written to,
 * from the same two independent probes the gateway's Smart routing card crosses:
 *
 *  - `/api/sidecar/status` — is the sidecar registered, and is it resident? Read
 *    from Core, not the gateway, because the sidecar is Core's and no gateway
 *    route reports it.
 *  - `/api/models/installed` — are its WEIGHTS on disk? Registered-but-idle is the
 *    sidecar's normal resting state, so the run state alone cannot tell a lazy
 *    tier apart from one whose non-fatal onboarding download failed and which will
 *    therefore bail on every start attempt.
 *
 * `undefined` for either probe while pending OR on failure (an older Core has no
 * `/api/models/installed`), which keeps the row silent instead of crying "not
 * downloaded" — {@link deriveClassifyTierState}, not this hook, decides what that
 * means. Only polled while the override is on — with it off there is no
 * classifier field to annotate — and keyed by node URL, so it shares one poll
 * with every other card on the same node.
 */
function useClassifyTier(
	target: ApiTarget,
	enabled: boolean
): ClassifyTierState {
	const status = useQuery({
		enabled,
		queryKey: ["sidecar-status", target.url],
		queryFn: () => fetchSidecarStatus(target),
		refetchInterval: CLASSIFY_STATUS_POLL_MS,
	});
	const weights = useQuery({
		enabled,
		queryKey: ["classify-weights", target.url],
		queryFn: () => fetchClassifyWeightsPresent(target),
		refetchInterval: CLASSIFY_WEIGHTS_POLL_MS,
	});
	return deriveClassifyTierState({
		sidecarStatus: status.isSuccess ? status.data : undefined,
		weightsPresent: weights.isSuccess ? weights.data : undefined,
	});
}

/**
 * Badge tone per tier state: `running` reads as active, `unweighted` is the one
 * state that is a genuine fault on this node, and `idle`/`absent` are neutral
 * facts.
 */
function classifyBadgeVariant(
	state: Exclude<ClassifyTierState, "unknown">
): "default" | "destructive" | "secondary" {
	if (state === "running") {
		return "default";
	}
	if (state === "unweighted") {
		return "destructive";
	}
	return "secondary";
}

/**
 * Status + one-click adopt row for the local classify tier, rendered under the
 * classifier field. The button only appears when this node can actually serve the
 * tier and it isn't already the selected value — offering it otherwise would hand
 * the user a model id whose call is guaranteed to fail.
 */
function ClassifyTierNote({
	onUse,
	state,
	value,
}: {
	onUse: () => void;
	state: ClassifyTierState;
	value: string;
}) {
	if (state === "unknown") {
		return null;
	}
	const copy = CLASSIFY_TIER_COPY[state];
	const servable = classifyTierServable(state);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge variant={classifyBadgeVariant(state)}>{copy.badge}</Badge>
			<span className="text-muted-foreground text-xs">{copy.hint}</span>
			{servable && value.trim() !== CLASSIFY_MODEL_ID ? (
				<Button onClick={onUse} size="sm" type="button" variant="ghost">
					Use it
				</Button>
			) : null}
		</div>
	);
}

export function AgentSmartRouteOverride({ agentId }: { agentId: string }) {
	const node = useActiveNode();
	// The app-wide "Friendly names" toggle picks which of the two vocabularies this
	// picker speaks. Read per-surface rather than threaded through props: all three
	// places that render this control now share one copy table, so each just asks.
	const [friendly] = useFriendlyMode();
	const strategyCopy = routeStrategyCopy(friendly);
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
	const classifierUnservedCopy = `Smart routing is on with the local classify tier as its classifier, but ${classifierUnservedReason}, so the classification call will fail and every request will quietly keep the model it asked for. Pick a model this node can reach.`;

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
				const cleanRules = rules
					.map((r) => ({
						description: r.description.trim(),
						model: r.model.trim(),
						weight: r.weight.trim() === "" ? 1 : Number(r.weight),
					}))
					.filter(
						(r) =>
							((draft.router_type ?? "llm_classifier") === "random" ||
								r.description) &&
							r.model &&
							Number.isFinite(r.weight) &&
							r.weight >= 0
					);
				const defaultModel = draft.default_model?.trim();
				const escalationConfirmations = draft.escalation_confirmations;
				const config: SmartRoutingConfig = {
					...draft,
					enabled: true,
					router_type: draft.router_type ?? "llm_classifier",
					strategy: draft.strategy ?? "llm",
					classifier_model: draft.classifier_model.trim(),
					embedding_model: draft.embedding_model?.trim() ?? "",
					similarity_threshold: Number.isFinite(draft.similarity_threshold)
						? draft.similarity_threshold
						: 0.35,
					random_seed:
						draft.random_seed === null || draft.random_seed === undefined
							? null
							: Number.isSafeInteger(draft.random_seed) &&
									draft.random_seed >= 0
								? draft.random_seed
								: null,
					stage_capable_model: draft.stage_capable_model?.trim() ?? "",
					stage_efficient_model: draft.stage_efficient_model?.trim() ?? "",
					stage_picker: draft.stage_picker ?? "capable_first",
					stage_confidence_threshold: Number.isFinite(
						draft.stage_confidence_threshold
					)
						? draft.stage_confidence_threshold
						: 0.5,
					stage_recent_message_window: Number.isInteger(
						draft.stage_recent_message_window
					)
						? draft.stage_recent_message_window
						: 3,
					escalation_weak_model: draft.escalation_weak_model?.trim() ?? "",
					escalation_strong_model: draft.escalation_strong_model?.trim() ?? "",
					escalation_judge_model: draft.escalation_judge_model?.trim() ?? "",
					escalation_confirmations:
						isNativeNumber(escalationConfirmations) &&
						Number.isInteger(escalationConfirmations) &&
						escalationConfirmations >= 1
							? escalationConfirmations
							: 2,
					escalation_recent_message_window: Number.isInteger(
						draft.escalation_recent_message_window
					)
						? draft.escalation_recent_message_window
						: 28,
					escalation_message_chars: Number.isInteger(
						draft.escalation_message_chars
					)
						? draft.escalation_message_chars
						: 500,
					rules: cleanRules,
					default_model: defaultModel ? defaultModel : null,
				};
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
			<div className="flex flex-col gap-3 rounded-md border border-destructive/30 p-4">
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
					<p className="text-muted-foreground text-xs">
						Replaces the gateway's global smart routing for this agent's
						requests, including an ACP agent whose model calls go through the
						gateway. Off falls back to the global router.
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
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-smart-route-type">Router type</Label>
						<Select<ModelRouterType>
							items={MODEL_ROUTER_TYPE_LABELS}
							onValueChange={(value) => value && patch({ router_type: value })}
							value={routerType}
						>
							<SelectTrigger id="agent-smart-route-type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{
									/* SAFETY: The imported authored MODEL_ROUTER_TYPE_LABELS supplies all five ModelRouterType keys with string labels and has no native mutation caller. Object.entries enumerates those own entries but erases their finite key union. */
									(
										Object.entries(MODEL_ROUTER_TYPE_LABELS) as [
											ModelRouterType,
											string,
										][]
									).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label} — {MODEL_ROUTER_TYPE_DESCRIPTIONS[value]}
										</SelectItem>
									))
								}
							</SelectContent>
						</Select>
					</div>

					{routerType === "llm_classifier" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-smart-route-strategy">
								{friendly ? "How to choose a rule" : "Strategy"}
							</Label>
							<Select<RouteStrategy>
								items={strategyCopy.labels}
								onValueChange={(v) => v && patch({ strategy: v })}
								value={draft.strategy ?? "llm"}
							>
								<SelectTrigger id="agent-smart-route-strategy">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{
										/* SAFETY: routeStrategyCopy selects the checked authored technical or friendly labels map; both own exactly llm/embedding/keyword with string labels. Native Object.entries erases only that complete RouteStrategy key union. */
										(
											Object.entries(strategyCopy.labels) as [
												RouteStrategy,
												string,
											][]
										).map(([val, label]) => (
											<SelectItem key={val} value={val}>
												{label}
											</SelectItem>
										))
									}
								</SelectContent>
							</Select>
						</div>
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
							<p className="text-muted-foreground text-xs">
								A cheap, fast model used only to sort requests. Any routable
								model id works (including local models or openrouter/ slugs).
							</p>
							{classifierDefaulted ? (
								<p className="text-muted-foreground text-xs">
									{CLASSIFIER_DEFAULTED_COPY}
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
						<>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-embedding">
									Embedding model
								</Label>
								<Input
									id="agent-smart-route-embedding"
									onChange={(e) => patch({ embedding_model: e.target.value })}
									placeholder="nomic-embed-text-v1.5 (default local)"
									value={draft.embedding_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<FluidSlider
									format={(v) => v.toFixed(2)}
									label="Similarity threshold"
									max={1}
									min={0}
									onValueChange={(similarity_threshold) =>
										patch({ similarity_threshold })
									}
									step={0.05}
									value={draft.similarity_threshold ?? 0.35}
								/>
							</div>
						</>
					) : null}

					{routerType === "random" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="agent-smart-route-seed">Seed (optional)</Label>
							<Input
								id="agent-smart-route-seed"
								inputMode="numeric"
								onChange={(event) => {
									const raw = event.target.value.trim();
									const seed = Number(raw);
									patch({
										random_seed:
											raw === "" || !Number.isSafeInteger(seed) || seed < 0
												? null
												: seed,
									});
								}}
								placeholder="Leave blank for normal traffic"
								value={draft.random_seed ?? ""}
							/>
							<p className="text-muted-foreground text-xs">
								Targets are selected independently per request; the seed is for
								reproducible tests, not conversation stickiness.
							</p>
						</div>
					) : null}

					{routerType === "stage_router" ? (
						<div className="flex flex-col gap-3 rounded-md border p-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-stage-capable">
									Capable model
								</Label>
								<Input
									id="agent-smart-route-stage-capable"
									onChange={(e) =>
										patch({ stage_capable_model: e.target.value })
									}
									placeholder="Model for exploration and recovery"
									value={draft.stage_capable_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-stage-efficient">
									Efficient model
								</Label>
								<Input
									id="agent-smart-route-stage-efficient"
									onChange={(e) =>
										patch({ stage_efficient_model: e.target.value })
									}
									placeholder="Model for settled mechanical work"
									value={draft.stage_efficient_model ?? ""}
								/>
							</div>
							<Label htmlFor="agent-smart-route-stage-picker">
								Ambiguous-turn default
							</Label>
							<Select<StagePicker>
								items={{
									capable_first: "Capable first",
									efficient_first: "Efficient first",
								}}
								onValueChange={(value) =>
									value && patch({ stage_picker: value })
								}
								value={draft.stage_picker ?? "capable_first"}
							>
								<SelectTrigger id="agent-smart-route-stage-picker">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="capable_first">Capable first</SelectItem>
									<SelectItem value="efficient_first">
										Efficient first
									</SelectItem>
								</SelectContent>
							</Select>
							<FluidSlider
								format={(value) => value.toFixed(2)}
								label="Signal confidence threshold"
								max={1}
								min={0}
								onValueChange={(stage_confidence_threshold) =>
									patch({ stage_confidence_threshold })
								}
								step={0.05}
								value={draft.stage_confidence_threshold ?? 0.5}
							/>
						</div>
					) : null}

					{routerType === "escalation" ? (
						<div className="flex flex-col gap-3 rounded-md border p-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-escalation-weak">
									Weak model
								</Label>
								<Input
									id="agent-smart-route-escalation-weak"
									onChange={(e) =>
										patch({ escalation_weak_model: e.target.value })
									}
									placeholder="Default model for routine turns"
									value={draft.escalation_weak_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-escalation-strong">
									Strong model
								</Label>
								<Input
									id="agent-smart-route-escalation-strong"
									onChange={(e) =>
										patch({ escalation_strong_model: e.target.value })
									}
									placeholder="Model for confirmed trouble"
									value={draft.escalation_strong_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-escalation-judge">
									Judge model
								</Label>
								<Input
									id="agent-smart-route-escalation-judge"
									onChange={(e) =>
										patch({ escalation_judge_model: e.target.value })
									}
									placeholder="Small model that returns ESCALATE or DECLINE"
									value={draft.escalation_judge_model ?? ""}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="agent-smart-route-escalation-confirmations">
									Confirmations before escalation
								</Label>
								<Input
									id="agent-smart-route-escalation-confirmations"
									inputMode="numeric"
									min={1}
									onChange={(e) =>
										patch({ escalation_confirmations: Number(e.target.value) })
									}
									placeholder="2"
									value={draft.escalation_confirmations ?? 2}
								/>
							</div>
							<p className="text-muted-foreground text-xs">
								Ryu judges the current transcript before routing and latches a
								session to strong after consecutive escalation verdicts.
							</p>
						</div>
					) : null}

					{routerType === "llm_classifier" || routerType === "random" ? (
						<>
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between">
									<Label>Rules</Label>
									<Button onClick={addRule} size="sm" variant="ghost">
										<HugeiconsIcon className="size-4" icon={Add01Icon} />
										Add rule
									</Button>
								</div>
								{rules.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No targets yet. Add a model below
										{routerType === "random"
											? " and give it a relative weight"
											: " with a matching rule"}
										.
									</p>
								) : (
									<div className="flex flex-col gap-3">
										{rules.map((rule, idx) => (
											<div className="flex items-start gap-2" key={rule.id}>
												<div className="flex flex-1 flex-col gap-1.5">
													<Input
														aria-label={`Rule ${idx + 1} description`}
														onChange={(e) =>
															updateRule(rule.id, "description", e.target.value)
														}
														placeholder={
															routerType === "random"
																? "Optional target label"
																: "When the request is about… (plain language)"
														}
														value={rule.description}
													/>
													<Input
														aria-label={`Rule ${idx + 1} model`}
														onChange={(e) =>
															updateRule(rule.id, "model", e.target.value)
														}
														placeholder="Route to model id (e.g. claude-sonnet-4-5)"
														value={rule.model}
													/>
													{routerType === "random" ? (
														<Input
															aria-label={`Rule ${idx + 1} weight`}
															inputMode="decimal"
															min={0}
															onChange={(e) =>
																updateRule(rule.id, "weight", e.target.value)
															}
															placeholder="Relative weight (default 1)"
															value={rule.weight}
														/>
													) : null}
												</div>
												<Button
													onClick={() => removeRule(rule.id)}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-3.5 text-status-destructive"
														icon={Delete01Icon}
													/>
													<span className="sr-only">Remove rule {idx + 1}</span>
												</Button>
											</div>
										))}
									</div>
								)}
							</div>

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

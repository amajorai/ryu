// apps/desktop/src/components/agents/AgentAutoRoutingEditor.tsx
//
// The agent-auto rules editor (Plane B — pick WHICH AGENT serves the turn),
// reachable from the universal picker's "Auto" row. Same visual shape as the
// gateway's SmartRoutingCard, but each rule targets an AGENT id (a select of
// installed agents) instead of a model id, plus a `default_agent_id` select. It
// writes the `agent-auto-routing` Core preference (see preferences.ts); Core
// resolves the sentinel `auto` agent against it per-turn.
//
// Mounted once (next to the Gateway dialog in NodeSelector) and driven by the
// `useAgentAutoDialog` store, so it lives clear of the picker dropdown's portal.

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
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
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	type ClassifyTierState,
	classifyTierCannotServeModel,
	classifyTierServable,
	deriveClassifyTierState,
	fetchClassifyWeightsPresent,
	type RouteStrategy,
	routeStrategyCopy,
} from "@/src/lib/api/gateway.ts";
import {
	type AgentAutoRoutingConfig,
	DEFAULT_AGENT_AUTO_ROUTING,
	getAgentAutoRouting,
	setAgentAutoRouting,
} from "@/src/lib/api/preferences.ts";
import { fetchSidecarStatus } from "@/src/lib/api/system.ts";
import { useAgentAutoDialog } from "@/src/store/useAgentAutoDialog.ts";

/** Editing row for one agent-auto rule, with a stable client-side id for keys. */
interface AutoRuleRow {
	agentId: string;
	description: string;
	id: string;
}

// Same cadences the gateway's Smart routing card polls at: the run state flips
// whenever the lazy sidecar starts, the weights land once after a download.
const CLASSIFY_STATUS_POLL_MS = 5000;
const CLASSIFY_WEIGHTS_POLL_MS = 30_000;

/**
 * The one copy for "on, with no classifier picked". Informational, not a warning:
 * Core's `de_classifier_model` (`agent_routing/auto.rs`) resolves a blank to the
 * classify tier's id, so the feature runs on the local classifier rather than not
 * at all. Deliberately the gateway Smart routing card's sentence with the one
 * noun this plane changes.
 *
 * It previously read "…so it never runs, and every turn falls back to the default
 * agent" — true of the old plain `#[serde(default)] String`, false once the field
 * gained its deserializer.
 */
const CLASSIFIER_DEFAULTED_COPY = `No classifier model is picked, so auto routing uses this node's local classifier (${CLASSIFY_MODEL_ID}). Enter a model id to route with something else.`;

/**
 * Live state of the local classify tier on the node this config is written to,
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
 * means. Only polled while the dialog is open, and keyed by node URL so it shares
 * one poll with every other card on the same node.
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

export function AgentAutoRoutingEditor() {
	const open = useAgentAutoDialog((s) => s.open);
	const setOpen = useAgentAutoDialog((s) => s.setOpen);
	const node = useActiveNode();
	const { agents } = useAgents();
	const routableAgents = useMemo(
		() => agents.filter((agent) => agent.lifecycleStatus === "active"),
		[agents]
	);
	// The app-wide "Friendly names" toggle picks which of the two vocabularies this
	// picker speaks. Read per-surface rather than threaded through props: all three
	// places that render this control now share one copy table, so each just asks.
	const [friendly] = useFriendlyMode();
	const strategyCopy = routeStrategyCopy(friendly);

	const [draft, setDraft] = useState<AgentAutoRoutingConfig>(
		DEFAULT_AGENT_AUTO_ROUTING
	);
	const [rules, setRules] = useState<AutoRuleRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
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
	const classifyTier = useClassifyTier(target, open);

	// Load the current config each time the dialog opens (fresh ground truth).
	useEffect(() => {
		if (!open) {
			setLoaded(false);
			return;
		}
		let cancelled = false;
		setLoaded(false);
		setLoadError(null);
		getAgentAutoRouting(target)
			.then((cfg) => {
				if (cancelled) {
					return;
				}
				setDraft(cfg);
				setRules(
					cfg.rules.map((r) => ({
						id: crypto.randomUUID(),
						description: r.description,
						agentId: r.agent_id,
					}))
				);
				setSaveError(null);
				setLoaded(true);
			})
			.catch((error) => {
				if (!cancelled) {
					setLoadError(
						error instanceof Error
							? error.message
							: "Could not load auto routing settings."
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [loadAttempt, open, target]);

	// The two states in which auto routing is enabled and yet inert, both of which
	// the resolver treats as a no-op WITHOUT saying so (`is_active` returns false
	// for the LLM strategy without a classifier, and the turn quietly falls back to
	// the default agent):
	//
	//  - the LLM strategy with a blank classifier model — the whole feature is off
	//    despite the switch reading on.
	//  - a classifier model served only by the local classify tier on a node that
	//    cannot serve it — either no such tier at all, or (the reachable case) the
	//    tier's weights were never downloaded so its sidecar can never start. The
	//    classification call errors, and routing fails open by design.
	const classifierModel = draft.classifier_model.trim();
	const smartLlm = draft.enabled && draft.strategy === "llm";
	const classifierDefaulted = smartLlm && classifierModel === "";
	// Probe the id Core will RESOLVE to, not the raw box — an empty string never
	// matches the classify-tier prefix, so probing the raw value would skip the
	// warning in exactly the cleared-box case that now lands on that tier.
	const resolvedClassifier = classifierModel || CLASSIFY_MODEL_ID;
	const classifierUnserved =
		smartLlm && classifyTierCannotServeModel(classifyTier, resolvedClassifier);
	const classifierUnservedReason =
		classifyTier === "absent" || classifyTier === "unweighted"
			? CLASSIFY_TIER_COPY[classifyTier].reason
			: null;
	const classifierUnservedCopy = `Auto routing is on with the local classify tier as its classifier, but ${classifierUnservedReason}, so the classification call will fail and every turn will quietly fall back to the default agent. Pick a model this node can reach.`;

	const patch = (p: Partial<AgentAutoRoutingConfig>) => {
		setDraft((prev) => ({ ...prev, ...p }));
		setSaveError(null);
	};

	const updateRule = (
		id: string,
		field: "description" | "agentId",
		value: string
	) => {
		setRules((prev) =>
			prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
		);
		setSaveError(null);
	};

	const addRule = () => {
		setRules((prev) => [
			...prev,
			{
				id: crypto.randomUUID(),
				description: "",
				agentId: routableAgents[0]?.id ?? "",
			},
		]);
	};

	const removeRule = (id: string) => {
		setRules((prev) => prev.filter((r) => r.id !== id));
	};

	const handleSave = async () => {
		setSaving(true);
		setSaveError(null);
		try {
			const cleanRules = rules
				.map((r) => ({
					description: r.description.trim(),
					agent_id: r.agentId.trim(),
				}))
				.filter((r) => r.description && r.agent_id);
			const config: AgentAutoRoutingConfig = {
				...draft,
				strategy: draft.strategy ?? "llm",
				classifier_model: draft.classifier_model.trim(),
				embedding_model: draft.embedding_model.trim(),
				similarity_threshold: Number.isFinite(draft.similarity_threshold)
					? draft.similarity_threshold
					: 0.35,
				rules: cleanRules,
				default_agent_id: draft.default_agent_id.trim() || "ryu",
			};
			const ok = await setAgentAutoRouting(target, config);
			if (ok) {
				// Closing the dialog takes the inline warnings with it, at the exact
				// moment the user needs them: the config persisted, the switch reads on,
				// and nothing will ever route. So an inert save says so on the way out
				// rather than looking like every other successful one.
				// Only the UNSERVED case still warns — a blank classifier resolves to
				// the local tier rather than switching the feature off.
				if (classifierUnserved) {
					sileo.warning({
						title: "Auto routing saved, but it will not run",
						description: classifierUnservedCopy,
					});
				}
				setOpen(false);
			} else {
				setSaveError("Failed to save. Is the node reachable?");
			}
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogContent appearance="auto-routing">
				<DialogHeader>
					<DialogTitle>Auto agent routing</DialogTitle>
					<DialogDescription>
						When you pick “Auto” in the composer, each turn is routed to the
						best agent by the rules below. Fails open to the default agent if no
						rule matches or the classifier errs.
					</DialogDescription>
				</DialogHeader>

				{loaded ? (
					<div className="flex flex-col gap-5 py-4">
						<div className="flex items-center justify-between gap-3">
							<div className="flex flex-col gap-0.5">
								<Label htmlFor="auto-enabled">Enable auto routing</Label>
								<p className="text-muted-foreground text-xs">
									Off by default. When off, “Auto” falls back to the default
									agent.
								</p>
							</div>
							<Switch
								checked={draft.enabled}
								id="auto-enabled"
								onCheckedChange={(v) => patch({ enabled: v })}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="auto-strategy">
								{friendly ? "How to choose a rule" : "Strategy"}
							</Label>
							<Select<RouteStrategy>
								items={strategyCopy.labels}
								onValueChange={(v) => v && patch({ strategy: v })}
								value={draft.strategy}
							>
								<SelectTrigger id="auto-strategy">
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
												<span className="font-medium">{label}</span>
												<span className="ml-1 text-muted-foreground text-xs">
													— {strategyCopy.descriptions[val]}
												</span>
											</SelectItem>
										))
									}
								</SelectContent>
							</Select>
						</div>

						{draft.strategy === "llm" ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="auto-classifier">Classifier model</Label>
								<Input
									id="auto-classifier"
									onChange={(e) => patch({ classifier_model: e.target.value })}
									placeholder="e.g. gemma-local, or a cheap routable model"
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

						{draft.strategy === "embedding" ? (
							<>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="auto-embedding">Embedding model</Label>
									<Input
										id="auto-embedding"
										onChange={(e) => patch({ embedding_model: e.target.value })}
										placeholder="nomic-embed-text-v1.5 (default local)"
										value={draft.embedding_model}
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
										value={draft.similarity_threshold}
									/>
								</div>
							</>
						) : null}

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
									No rules yet. Add one like “writing or debugging code” →
									Claude Code.
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
													placeholder="When the request is about… (plain language)"
													value={rule.description}
												/>
												<Select
													items={routableAgents.map((a) => ({
														value: a.id,
														label: a.name,
													}))}
													onValueChange={(v) =>
														v && updateRule(rule.id, "agentId", v)
													}
													value={rule.agentId}
												>
													<SelectTrigger>
														<SelectValue placeholder="Route to agent" />
													</SelectTrigger>
													<SelectContent>
														{routableAgents.map((a) => (
															<SelectItem key={a.id} value={a.id}>
																<span className="font-medium">{a.name}</span>
																<span className="ml-1 text-muted-foreground text-xs">
																	— {a.id}
																</span>
															</SelectItem>
														))}
													</SelectContent>
												</Select>
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

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="auto-default-agent">
								Default agent when no rule matches
							</Label>
							<Select
								items={routableAgents.map((a) => ({
									value: a.id,
									label: a.name,
								}))}
								onValueChange={(v) => v && patch({ default_agent_id: v })}
								value={draft.default_agent_id}
							>
								<SelectTrigger id="auto-default-agent">
									<SelectValue placeholder="Select an agent" />
								</SelectTrigger>
								<SelectContent>
									{routableAgents.map((a) => (
										<SelectItem key={a.id} value={a.id}>
											<span className="font-medium">{a.name}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {a.id}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="flex items-center justify-between gap-3">
							<div className="flex flex-col gap-0.5">
								<Label htmlFor="auto-cache">
									Resolve once per conversation
								</Label>
								<p className="text-muted-foreground text-xs">
									Keeps a conversation on one agent instead of re-picking every
									turn.
								</p>
							</div>
							<Switch
								checked={draft.cache_by_session}
								id="auto-cache"
								onCheckedChange={(v) => patch({ cache_by_session: v })}
							/>
						</div>

						{saveError ? (
							<p className="text-sm text-status-destructive" role="alert">
								{saveError}
							</p>
						) : null}
					</div>
				) : loadError ? (
					<div className="flex flex-col items-start gap-3 py-6" role="alert">
						<p className="text-sm text-status-destructive">
							Auto routing settings could not be loaded. {loadError}
						</p>
						<Button
							onClick={() => setLoadAttempt((attempt) => attempt + 1)}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					</div>
				) : (
					<SkeletonRows spacing="expanded" />
				)}

				<DialogFooter>
					<Button onClick={() => setOpen(false)} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={!loaded}
						loading={saving}
						onClick={() => handleSave()}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

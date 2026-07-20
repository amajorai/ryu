// apps/desktop/src/components/agents/AgentSmartRouteOverride.tsx
//
// Per-agent Plane A override (the "both" config scope): give ONE agent its own
// model-routing rules that replace the gateway's global smart_routing for that
// agent's chat turns. Writes a per-agent SmartRoutingConfig to the
// `agent-smart-route` Core preference (keyed by agent id); Core injects it as the
// request body's `ryu_smart_route` field when forwarding that agent's OpenAI-compat
// chat, and the gateway builds an ephemeral router for it (spec §1). Off (the
// master switch) clears the override, so the agent falls back to the global router.

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Slider } from "@ryu/ui/components/slider";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_SMART_ROUTING,
	type RouteStrategy,
	type SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import {
	getAgentSmartRoute,
	setAgentSmartRoute,
} from "@/src/lib/api/preferences.ts";

interface RuleRow {
	description: string;
	id: string;
	model: string;
}

const STRATEGY_LABELS: Record<RouteStrategy, string> = {
	llm: "LLM classifier",
	embedding: "Embedding",
	keyword: "Keyword",
};

export function AgentSmartRouteOverride({ agentId }: { agentId: string }) {
	const getNode = useActiveNodeGetter();
	const [enabled, setEnabled] = useState(false);
	const [draft, setDraft] = useState<SmartRoutingConfig>(DEFAULT_SMART_ROUTING);
	const [rules, setRules] = useState<RuleRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(getNode());
		getAgentSmartRoute(target, agentId).then((cfg) => {
			if (cancelled) {
				return;
			}
			setEnabled(cfg !== null);
			const base = cfg ?? DEFAULT_SMART_ROUTING;
			setDraft(base);
			setRules(
				base.rules.map((r) => ({
					id: crypto.randomUUID(),
					description: r.description,
					model: r.model,
				}))
			);
			setLoaded(true);
		});
		return () => {
			cancelled = true;
		};
	}, [agentId, getNode]);

	const patch = (p: Partial<SmartRoutingConfig>) =>
		setDraft((prev) => ({ ...prev, ...p }));

	const updateRule = (
		id: string,
		field: "description" | "model",
		value: string
	) =>
		setRules((prev) =>
			prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
		);

	const addRule = () =>
		setRules((prev) => [
			...prev,
			{ id: crypto.randomUUID(), description: "", model: "" },
		]);

	const removeRule = (id: string) =>
		setRules((prev) => prev.filter((r) => r.id !== id));

	const handleSave = async () => {
		setSaving(true);
		const target = toTarget(getNode());
		let ok = false;
		if (enabled) {
			const cleanRules = rules
				.map((r) => ({
					description: r.description.trim(),
					model: r.model.trim(),
				}))
				.filter((r) => r.description && r.model);
			const defaultModel = draft.default_model?.trim();
			const config: SmartRoutingConfig = {
				...draft,
				enabled: true,
				strategy: draft.strategy ?? "llm",
				classifier_model: draft.classifier_model.trim(),
				embedding_model: draft.embedding_model?.trim() ?? "",
				similarity_threshold: Number.isFinite(draft.similarity_threshold)
					? draft.similarity_threshold
					: 0.35,
				rules: cleanRules,
				default_model: defaultModel ? defaultModel : null,
			};
			ok = await setAgentSmartRoute(target, agentId, config);
		} else {
			ok = await setAgentSmartRoute(target, agentId, null);
		}
		setSaving(false);
		if (ok) {
			sileo.success({
				title: enabled
					? "Per-agent routing saved"
					: "Per-agent routing override cleared",
				description: enabled
					? "This agent's chat now routes by its own rules."
					: undefined,
			});
		} else {
			sileo.error({ title: "Failed to save per-agent routing" });
		}
	};

	if (!loaded) {
		return (
			<div className="flex items-center justify-center py-6">
				<Spinner className="size-5" />
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
						Replaces the gateway's global smart routing for this agent's chat.
						Off falls back to the global router.
					</p>
				</div>
				<Switch
					checked={enabled}
					id="agent-smart-route-enabled"
					onCheckedChange={setEnabled}
				/>
			</div>

			{enabled ? (
				<>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="agent-smart-route-strategy">Strategy</Label>
						<Select
							items={STRATEGY_LABELS}
							onValueChange={(v) =>
								v && patch({ strategy: v as RouteStrategy })
							}
							value={draft.strategy ?? "llm"}
						>
							<SelectTrigger id="agent-smart-route-strategy">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(
									Object.entries(STRATEGY_LABELS) as [RouteStrategy, string][]
								).map(([val, label]) => (
									<SelectItem key={val} value={val}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{(draft.strategy ?? "llm") === "llm" ? (
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
						</div>
					) : null}

					{draft.strategy === "embedding" ? (
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
								<div className="flex items-center justify-between">
									<Label htmlFor="agent-smart-route-threshold">
										Similarity threshold
									</Label>
									<span className="text-muted-foreground text-xs tabular-nums">
										{(draft.similarity_threshold ?? 0.35).toFixed(2)}
									</span>
								</div>
								<Slider
									aria-label="Similarity threshold"
									max={1}
									min={0}
									onValueChange={(v: number | number[]) =>
										patch({
											similarity_threshold: Array.isArray(v) ? v[0] : v,
										})
									}
									step={0.05}
									value={[draft.similarity_threshold ?? 0.35]}
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
								“claude-sonnet-4-5”.
							</p>
						) : (
							<div className="flex flex-col gap-3">
								{rules.map((rule, idx) => (
									<div className="flex items-start gap-2" key={rule.id}>
										<div className="flex flex-1 flex-col gap-1.5">
											<Input
												onChange={(e) =>
													updateRule(rule.id, "description", e.target.value)
												}
												placeholder="When the request is about… (plain language)"
												value={rule.description}
											/>
											<Input
												onChange={(e) =>
													updateRule(rule.id, "model", e.target.value)
												}
												placeholder="Route to model id (e.g. claude-sonnet-4-5)"
												value={rule.model}
											/>
										</div>
										<Button
											onClick={() => removeRule(rule.id)}
											size="icon"
											variant="ghost"
										>
											<HugeiconsIcon
												className="size-3.5 text-destructive"
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
				</>
			) : null}

			<div className="flex justify-end">
				<Button disabled={saving} onClick={() => handleSave()} size="sm">
					{saving ? <Spinner className="size-4" /> : null}
					Save
				</Button>
			</div>
		</div>
	);
}

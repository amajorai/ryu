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
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
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
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import type { RouteStrategy } from "@/src/lib/api/gateway.ts";
import {
	type AgentAutoRoutingConfig,
	DEFAULT_AGENT_AUTO_ROUTING,
	getAgentAutoRouting,
	setAgentAutoRouting,
} from "@/src/lib/api/preferences.ts";
import { useAgentAutoDialog } from "@/src/store/useAgentAutoDialog.ts";

/** Editing row for one agent-auto rule, with a stable client-side id for keys. */
interface AutoRuleRow {
	agentId: string;
	description: string;
	id: string;
}

const STRATEGY_LABELS: Record<RouteStrategy, string> = {
	llm: "LLM classifier",
	embedding: "Embedding",
	keyword: "Keyword",
};

const STRATEGY_DESCRIPTIONS: Record<RouteStrategy, string> = {
	llm: "a cheap model reads the message and picks a rule",
	embedding: "cosine-match rule text against the message",
	keyword: "case-insensitive word match, zero cost",
};

export function AgentAutoRoutingEditor() {
	const open = useAgentAutoDialog((s) => s.open);
	const setOpen = useAgentAutoDialog((s) => s.setOpen);
	const getNode = useActiveNodeGetter();
	const { agents } = useAgents();

	const [draft, setDraft] = useState<AgentAutoRoutingConfig>(
		DEFAULT_AGENT_AUTO_ROUTING
	);
	const [rules, setRules] = useState<AutoRuleRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Load the current config each time the dialog opens (fresh ground truth).
	useEffect(() => {
		if (!open) {
			setLoaded(false);
			return;
		}
		let cancelled = false;
		const target = toTarget(getNode());
		getAgentAutoRouting(target).then((cfg) => {
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
		});
		return () => {
			cancelled = true;
		};
	}, [open, getNode]);

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
				agentId: agents[0]?.id ?? "",
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
			const target = toTarget(getNode());
			const ok = await setAgentAutoRouting(target, config);
			if (ok) {
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
			<DialogContent className="max-h-[85vh] gap-0 overflow-y-auto sm:max-w-lg">
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
							<Label htmlFor="auto-strategy">Strategy</Label>
							<Select
								items={STRATEGY_LABELS}
								onValueChange={(v) =>
									v && patch({ strategy: v as RouteStrategy })
								}
								value={draft.strategy}
							>
								<SelectTrigger id="auto-strategy">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(
										Object.entries(STRATEGY_LABELS) as [RouteStrategy, string][]
									).map(([val, label]) => (
										<SelectItem key={val} value={val}>
											<span className="font-medium">{label}</span>
											<span className="ml-1 text-muted-foreground text-xs">
												— {STRATEGY_DESCRIPTIONS[val]}
											</span>
										</SelectItem>
									))}
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
									<div className="flex items-center justify-between">
										<Label htmlFor="auto-threshold">Similarity threshold</Label>
										<span className="text-muted-foreground text-xs tabular-nums">
											{draft.similarity_threshold.toFixed(2)}
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
										value={[draft.similarity_threshold]}
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
													onChange={(e) =>
														updateRule(rule.id, "description", e.target.value)
													}
													placeholder="When the request is about… (plain language)"
													value={rule.description}
												/>
												<Select
													items={agents.map((a) => ({
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
														{agents.map((a) => (
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
							<Label htmlFor="auto-default-agent">
								Default agent when no rule matches
							</Label>
							<Select
								items={agents.map((a) => ({ value: a.id, label: a.name }))}
								onValueChange={(v) => v && patch({ default_agent_id: v })}
								value={draft.default_agent_id}
							>
								<SelectTrigger id="auto-default-agent">
									<SelectValue placeholder="Select an agent" />
								</SelectTrigger>
								<SelectContent>
									{agents.map((a) => (
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
							<p className="text-destructive text-sm">{saveError}</p>
						) : null}
					</div>
				) : (
					<div className="flex items-center justify-center py-10">
						<Spinner className="size-5" />
					</div>
				)}

				<DialogFooter>
					<Button onClick={() => setOpen(false)} variant="ghost">
						Cancel
					</Button>
					<Button disabled={!loaded || saving} onClick={() => handleSave()}>
						{saving ? <Spinner className="size-4" /> : null}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

import { useLiteralMessages } from "@ryu/i18n/react";
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
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ClassifyTierState,
	ModelRouterType,
	RouteStrategy,
	SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import {
	CLASSIFY_MODEL_ID,
	MODEL_ROUTER_TYPE_DESCRIPTIONS,
	MODEL_ROUTER_TYPE_LABELS,
	type routeStrategyCopy,
} from "@/src/lib/api/gateway.ts";
import { ClassifyTierNote } from "./classify-tier.tsx";

/**
 * The algorithm half of `SmartRoutingCard`'s router form: the router type and
 * the fields each algorithm reads. Rendered inside the card's form, before the
 * rules editor.
 */
export function SmartRouterAlgorithmFields({
	classifierDefaulted,
	classifierUnserved,
	classifierUnservedReason,
	classifyTier,
	draft,
	isDisabled,
	patch,
	routerType,
	strategyCopy,
	target,
}: {
	classifierDefaulted: boolean;
	classifierUnserved: boolean;
	classifierUnservedReason: string | null;
	classifyTier: ClassifyTierState;
	draft: SmartRoutingConfig | null;
	isDisabled: boolean;
	patch: (p: Partial<SmartRoutingConfig>) => void;
	routerType: ModelRouterType;
	strategyCopy: ReturnType<typeof routeStrategyCopy>;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="smart-router-type">Router type</Label>
				<Select
					items={MODEL_ROUTER_TYPE_LABELS}
					onValueChange={(v) => v && patch({ router_type: v })}
					value={routerType}
				>
					<SelectTrigger disabled={isDisabled} id="smart-router-type">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{
							/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
								Object.entries(MODEL_ROUTER_TYPE_LABELS) as [
									ModelRouterType,
									string,
								][]
							).map(([value, label]) => (
								<SelectItem key={value} value={value}>
									<span className="font-medium">{label}</span>
									<span className="ml-1 text-muted-foreground text-xs">
										— {MODEL_ROUTER_TYPE_DESCRIPTIONS[value]}
									</span>
								</SelectItem>
							))
						}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					Choose the model-selection algorithm. The normal provider routing,
					governance, budgets, and audit path still run after this choice.
				</p>
			</div>

			{routerType === "llm_classifier" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="smart-strategy">Strategy</Label>
					<Select
						items={strategyCopy.labels}
						onValueChange={(v) => v && patch({ strategy: v })}
						value={draft?.strategy ?? "llm"}
					>
						<SelectTrigger disabled={isDisabled} id="smart-strategy">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{
								/* SAFETY: This authored complete string-label map is checked against its closed native domain key union; Object.entries returns its own keys but erases their literal-key types. */ (
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
					<p className="text-muted-foreground text-xs">
						How the matching rule is chosen. LLM asks a cheap classifier;
						Embedding cosine-matches rule text; Keyword is a zero-cost word
						match.
					</p>
				</div>
			) : null}

			{routerType === "llm_classifier" &&
			(draft?.strategy ?? "llm") === "llm" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="smart-classifier-model">Classifier model</Label>
					<AgentModelPickerField
						ariaLabel="Classifier model"
						disabled={isDisabled}
						mode="model"
						onChange={(next) => patch({ classifier_model: next })}
						placeholder="e.g. gpt-4o-mini, or a local model"
						target={target}
						value={draft?.classifier_model ?? ""}
					/>
					<p className="text-muted-foreground text-xs">
						A cheap, fast model used only to sort requests. Any routable model
						id works (including local models or openrouter/ slugs).
					</p>
					{classifierDefaulted ? (
						<p className="text-muted-foreground text-xs">
							{tl(
								"No classifier model is picked, so smart routing uses this node's local classifier ({CLASSIFY_MODEL_ID}). Enter a model id to route with something else.",
								{ CLASSIFY_MODEL_ID }
							)}
						</p>
					) : null}
					{classifierUnserved ? (
						<p className="text-status-destructive text-xs">
							{tl(
								"Smart routing is on with the local classify tier as its classifier, but {classifierUnservedReason}, so the classification call will fail and every request will quietly keep the model it asked for. Pick a model this node can reach.",
								{ classifierUnservedReason }
							)}
						</p>
					) : null}
					<ClassifyTierNote
						disabled={isDisabled}
						onUse={() => patch({ classifier_model: CLASSIFY_MODEL_ID })}
						state={classifyTier}
						value={draft?.classifier_model ?? ""}
					/>
				</div>
			) : null}

			{routerType === "llm_classifier" && draft?.strategy === "embedding" ? (
				<>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-embedding-model">Embedding model</Label>
						<Input
							disabled={isDisabled}
							id="smart-embedding-model"
							onChange={(e) => patch({ embedding_model: e.target.value })}
							placeholder="nomic-embed-text-v1.5 (default local)"
							value={draft?.embedding_model ?? ""}
						/>
						<p className="text-muted-foreground text-xs">
							Embedder used to match rules by meaning. Leave blank for the
							default local embedder.
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<FluidSlider
							disabled={isDisabled}
							format={(v) => v.toFixed(2)}
							label="Similarity threshold"
							max={1}
							min={0}
							onValueChange={(similarity_threshold) =>
								patch({ similarity_threshold })
							}
							step={0.05}
							value={draft?.similarity_threshold ?? 0.35}
						/>
						<p className="text-muted-foreground text-xs">
							Minimum cosine similarity for a rule to match. Higher is stricter.
						</p>
					</div>
				</>
			) : null}

			{routerType === "random" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="smart-random-seed">Seed (optional)</Label>
					<Input
						disabled={isDisabled}
						id="smart-random-seed"
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
						value={draft?.random_seed ?? ""}
					/>
					<p className="text-muted-foreground text-xs">
						Targets are selected independently per request. A seed reproduces
						the sequence for tests and benchmarks; it does not make a
						conversation sticky.
					</p>
				</div>
			) : null}

			{routerType === "stage_router" ? (
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-stage-capable">Capable model</Label>
						<AgentModelPickerField
							ariaLabel="Stage capable model"
							disabled={isDisabled}
							mode="model"
							onChange={(next) => patch({ stage_capable_model: next })}
							placeholder="Model for exploration and recovery"
							target={target}
							value={draft?.stage_capable_model ?? ""}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-stage-efficient">Efficient model</Label>
						<AgentModelPickerField
							ariaLabel="Stage efficient model"
							disabled={isDisabled}
							mode="model"
							onChange={(next) => patch({ stage_efficient_model: next })}
							placeholder="Model for settled mechanical work"
							target={target}
							value={draft?.stage_efficient_model ?? ""}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-stage-picker">Ambiguous-turn default</Label>
						<Select
							items={{
								capable_first: "Capable first",
								efficient_first: "Efficient first",
							}}
							onValueChange={(value) => value && patch({ stage_picker: value })}
							value={draft?.stage_picker ?? "capable_first"}
						>
							<SelectTrigger disabled={isDisabled} id="smart-stage-picker">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="capable_first">Capable first</SelectItem>
								<SelectItem value="efficient_first">Efficient first</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<FluidSlider
						disabled={isDisabled}
						format={(value) => value.toFixed(2)}
						label="Signal confidence threshold"
						max={1}
						min={0}
						onValueChange={(stage_confidence_threshold) =>
							patch({ stage_confidence_threshold })
						}
						step={0.05}
						value={draft?.stage_confidence_threshold ?? 0.5}
					/>
					<p className="text-muted-foreground text-xs">
						Ryu reads recent tool/result history. Errors and exploration favor
						the capable model; writes and passing tests favor the efficient
						model.
					</p>
				</div>
			) : null}

			{routerType === "escalation" ? (
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-escalation-weak">Weak model</Label>
						<AgentModelPickerField
							ariaLabel="Escalation weak model"
							disabled={isDisabled}
							mode="model"
							onChange={(next) => patch({ escalation_weak_model: next })}
							placeholder="Default model for routine turns"
							target={target}
							value={draft?.escalation_weak_model ?? ""}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-escalation-strong">Strong model</Label>
						<AgentModelPickerField
							ariaLabel="Escalation strong model"
							disabled={isDisabled}
							mode="model"
							onChange={(next) => patch({ escalation_strong_model: next })}
							placeholder="Model for confirmed trouble"
							target={target}
							value={draft?.escalation_strong_model ?? ""}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-escalation-judge">Judge model</Label>
						<AgentModelPickerField
							ariaLabel="Escalation judge model"
							disabled={isDisabled}
							mode="model"
							onChange={(next) => patch({ escalation_judge_model: next })}
							placeholder="Small model that returns ESCALATE or DECLINE"
							target={target}
							value={draft?.escalation_judge_model ?? ""}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="smart-escalation-confirmations">
							Confirmations before escalation
						</Label>
						<Input
							disabled={isDisabled}
							id="smart-escalation-confirmations"
							inputMode="numeric"
							min={1}
							onChange={(event) =>
								patch({
									escalation_confirmations: Number(event.target.value),
								})
							}
							placeholder="2"
							value={draft?.escalation_confirmations ?? 2}
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						The judge sees the current transcript before routing. Consecutive
						ESCALATE verdicts latch sessions to the strong model; judge failures
						use the weak model. This preflight mode does not replay a completed
						weak response through the strong model.
					</p>
				</div>
			) : null}
		</>
	);
}

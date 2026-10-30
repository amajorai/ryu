// apps/desktop/src/components/agents/AgentSmartRouteOverride-router-fields.tsx
//
// Router-type-specific fields of the per-agent smart-route override.

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
import type { SmartRoutingConfig, StagePicker } from "@/src/lib/api/gateway.ts";

export function EmbeddingFields({
	draft,
	patch,
}: {
	draft: SmartRoutingConfig;
	patch: (p: Partial<SmartRoutingConfig>) => void;
}) {
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="agent-smart-route-embedding">Embedding model</Label>
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
	);
}

export function RandomSeedField({
	draft,
	patch,
}: {
	draft: SmartRoutingConfig;
	patch: (p: Partial<SmartRoutingConfig>) => void;
}) {
	return (
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
	);
}

export function StageRouterFields({
	draft,
	patch,
}: {
	draft: SmartRoutingConfig;
	patch: (p: Partial<SmartRoutingConfig>) => void;
}) {
	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="agent-smart-route-stage-capable">Capable model</Label>
				<Input
					id="agent-smart-route-stage-capable"
					onChange={(e) => patch({ stage_capable_model: e.target.value })}
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
					onChange={(e) => patch({ stage_efficient_model: e.target.value })}
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
				onValueChange={(value) => value && patch({ stage_picker: value })}
				value={draft.stage_picker ?? "capable_first"}
			>
				<SelectTrigger id="agent-smart-route-stage-picker">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="capable_first">Capable first</SelectItem>
					<SelectItem value="efficient_first">Efficient first</SelectItem>
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
	);
}

export function EscalationFields({
	draft,
	patch,
}: {
	draft: SmartRoutingConfig;
	patch: (p: Partial<SmartRoutingConfig>) => void;
}) {
	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="agent-smart-route-escalation-weak">Weak model</Label>
				<Input
					id="agent-smart-route-escalation-weak"
					onChange={(e) => patch({ escalation_weak_model: e.target.value })}
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
					onChange={(e) => patch({ escalation_strong_model: e.target.value })}
					placeholder="Model for confirmed trouble"
					value={draft.escalation_strong_model ?? ""}
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="agent-smart-route-escalation-judge">Judge model</Label>
				<Input
					id="agent-smart-route-escalation-judge"
					onChange={(e) => patch({ escalation_judge_model: e.target.value })}
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
				Ryu judges the current transcript before routing and latches a session
				to strong after consecutive escalation verdicts.
			</p>
		</div>
	);
}

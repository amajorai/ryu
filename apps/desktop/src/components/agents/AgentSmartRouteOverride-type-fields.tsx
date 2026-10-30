// apps/desktop/src/components/agents/AgentSmartRouteOverride-type-fields.tsx
//
// Router-type and strategy pickers of the per-agent smart-route override.

import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	MODEL_ROUTER_TYPE_DESCRIPTIONS,
	MODEL_ROUTER_TYPE_LABELS,
	type ModelRouterType,
	type RouteStrategy,
	type routeStrategyCopy,
	type SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";

export function RouterTypeField({
	patch,
	routerType,
}: {
	patch: (p: Partial<SmartRoutingConfig>) => void;
	routerType: ModelRouterType;
}) {
	return (
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
	);
}

export function StrategyField({
	draft,
	friendly,
	patch,
	strategyCopy,
}: {
	draft: SmartRoutingConfig;
	friendly: boolean;
	patch: (p: Partial<SmartRoutingConfig>) => void;
	strategyCopy: ReturnType<typeof routeStrategyCopy>;
}) {
	return (
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
							Object.entries(strategyCopy.labels) as [RouteStrategy, string][]
						).map(([val, label]) => (
							<SelectItem key={val} value={val}>
								{label}
							</SelectItem>
						))
					}
				</SelectContent>
			</Select>
		</div>
	);
}

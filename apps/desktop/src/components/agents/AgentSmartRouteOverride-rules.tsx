// apps/desktop/src/components/agents/AgentSmartRouteOverride-rules.tsx
//
// Rule/target list of the per-agent smart-route override.

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type { ModelRouterType } from "@/src/lib/api/gateway.ts";
import type { RuleRow } from "./AgentSmartRouteOverride-load.ts";

export function RulesSection({
	addRule,
	removeRule,
	routerType,
	rules,
	updateRule,
}: {
	addRule: () => void;
	removeRule: (id: string) => void;
	routerType: ModelRouterType;
	rules: RuleRow[];
	updateRule: (
		id: string,
		field: "description" | "model" | "weight",
		value: string
	) => void;
}) {
	const tl = useLiteralMessages();
	return (
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
					{routerType === "random"
						? tl(
								"No targets yet. Add a model below and give it a relative weight."
							)
						: tl("No targets yet. Add a model below with a matching rule.")}
				</p>
			) : (
				<div className="flex flex-col gap-3">
					{rules.map((rule, idx) => (
						<div className="flex items-start gap-2" key={rule.id}>
							<div className="flex flex-1 flex-col gap-1.5">
								<Input
									aria-label={tl("Rule {number} description", {
										number: idx + 1,
									})}
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
									aria-label={tl("Rule {number} model", { number: idx + 1 })}
									onChange={(e) => updateRule(rule.id, "model", e.target.value)}
									placeholder="Route to model id (e.g. claude-sonnet-4-5)"
									value={rule.model}
								/>
								{routerType === "random" ? (
									<Input
										aria-label={tl("Rule {number} weight", { number: idx + 1 })}
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
								<span className="sr-only">
									{tl("Remove rule {number}", { number: idx + 1 })}
								</span>
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

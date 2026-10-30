import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ModelRouterType,
	SmartRoutingConfig,
} from "@/src/lib/api/gateway.ts";
import type { RuleRow } from "./classify-tier.tsx";

/**
 * The rules half of `SmartRoutingCard`'s router form: the rule (or weighted
 * target) list and, for the classifier, the no-match default model. Renders
 * nothing for router types that take no rules.
 */
export function SmartRoutingRulesEditor({
	addRule,
	draft,
	isDisabled,
	patch,
	removeRule,
	routerType,
	rules,
	target,
	updateRule,
}: {
	addRule: () => void;
	draft: SmartRoutingConfig | null;
	isDisabled: boolean;
	patch: (p: Partial<SmartRoutingConfig>) => void;
	removeRule: (id: string) => void;
	routerType: ModelRouterType;
	rules: RuleRow[];
	target: ApiTarget;
	updateRule: (
		id: string,
		field: "description" | "model" | "weight",
		value: string
	) => void;
}) {
	const tl = useLiteralMessages();
	return routerType === "llm_classifier" || routerType === "random" ? (
		<>
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<Label>Rules</Label>
					<Button
						disabled={isDisabled}
						onClick={addRule}
						size="sm"
						variant="ghost"
					>
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
										disabled={isDisabled}
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
									<AgentModelPickerField
										ariaLabel={tl("Route to model for rule {number}", {
											number: idx + 1,
										})}
										disabled={isDisabled}
										mode="model"
										onChange={(next) => updateRule(rule.id, "model", next)}
										placeholder="Route to model id (e.g. claude-sonnet-4-5)"
										target={target}
										value={rule.model}
									/>
									{routerType === "random" ? (
										<Input
											aria-label={tl("Rule {number} weight", {
												number: idx + 1,
											})}
											disabled={isDisabled}
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
									disabled={isDisabled}
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

			{routerType === "llm_classifier" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="smart-default-model">
						Default model when no rule matches
					</Label>
					<AgentModelPickerField
						ariaLabel="Default model when no rule matches"
						disabled={isDisabled}
						mode="model"
						onChange={(next) => patch({ default_model: next })}
						placeholder="Leave blank to keep the originally requested model"
						target={target}
						value={draft?.default_model ?? ""}
					/>
				</div>
			) : null}
		</>
	) : null;
}

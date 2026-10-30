// apps/desktop/src/components/agents/AgentAutoRoutingEditor-rules-section.tsx
//
// The rules list of the agent-auto rules editor: one description + target-agent
// row per rule (split out of AgentAutoRoutingEditor.tsx).

import { Add01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";

/** Editing row for one agent-auto rule, with a stable client-side id for keys. */
export interface AutoRuleRow {
	agentId: string;
	description: string;
	id: string;
}

export function AgentAutoRoutingRulesSection({
	addRule,
	removeRule,
	routableAgents,
	rules,
	updateRule,
}: {
	addRule: () => void;
	removeRule: (id: string) => void;
	routableAgents: readonly { id: string; name: string }[];
	rules: AutoRuleRow[];
	updateRule: (
		id: string,
		field: "description" | "agentId",
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
					No rules yet. Add one like “writing or debugging code” → Claude Code.
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
									placeholder="When the request is about… (plain language)"
									value={rule.description}
								/>
								<Select
									items={routableAgents.map((a) => ({
										value: a.id,
										label: a.name,
									}))}
									onValueChange={(v) => v && updateRule(rule.id, "agentId", v)}
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

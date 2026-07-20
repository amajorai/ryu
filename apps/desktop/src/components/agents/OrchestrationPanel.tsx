// apps/desktop/src/components/agents/OrchestrationPanel.tsx
//
// The agent edit page's Orchestration section. Two per-agent capability toggles
// that travel with the normal agent save (unlike the model-capability overrides
// in AgentCapabilitiesPanel, which persist via a separate endpoint):
//
//   - Orchestrator: may discover other agents (orchestrator__discover_agents)
//     and delegate work to them (delegate__fanout). Default on.
//   - Create agents: may mint new custom agents (agent_builder__create_agent).
//     Default off — a privileged capability, enabled per agent.
//
// Controlled by AgentEditPage state so the values are folded into the agent's
// create/update body alongside tools, skills, persona, etc.

import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";

const ON_OFF = [
	{ value: true, label: "On" },
	{ value: false, label: "Off" },
] as const;

/** A small segmented On / Off control for one boolean capability. */
function OnOffToggle({
	value,
	onChange,
	disabled,
	ariaLabel,
}: {
	value: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	ariaLabel: string;
}) {
	return (
		<fieldset
			aria-label={ariaLabel}
			className="m-0 inline-flex min-w-0 items-center rounded-md border p-0.5"
		>
			{ON_OFF.map((opt) => (
				<Button
					aria-pressed={value === opt.value}
					className={cn(
						"h-6 px-2 text-xs",
						value === opt.value && "bg-accent text-accent-foreground"
					)}
					disabled={disabled}
					key={opt.label}
					onClick={() => onChange(opt.value)}
					size="sm"
					type="button"
					variant="ghost"
				>
					{opt.label}
				</Button>
			))}
		</fieldset>
	);
}

const ROWS = [
	{
		key: "orchestrator" as const,
		label: "Delegate to other agents",
		hint: "Discover other agents and hand them subtasks. On by default.",
	},
	{
		key: "canCreateAgents" as const,
		label: "Create new agents",
		hint: "Mint new custom agents on the fly. Privileged — off by default.",
	},
];

export function OrchestrationPanel({
	orchestrator,
	canCreateAgents,
	onChangeOrchestrator,
	onChangeCanCreateAgents,
	disabled,
}: {
	orchestrator: boolean;
	canCreateAgents: boolean;
	onChangeOrchestrator: (next: boolean) => void;
	onChangeCanCreateAgents: (next: boolean) => void;
	disabled?: boolean;
}) {
	const values: Record<string, boolean> = {
		orchestrator,
		canCreateAgents,
	};
	const handlers: Record<string, (next: boolean) => void> = {
		orchestrator: onChangeOrchestrator,
		canCreateAgents: onChangeCanCreateAgents,
	};

	return (
		<SettingsSection
			caption="Whether this agent can hand work to other agents, and whether it may create new ones. Delegation targets a real agent (its own tools and persona); creation is gated because a created agent can be granted tools."
			title="Orchestration"
		>
			<SettingsGroup>
				{ROWS.map((row) => (
					<SettingsItem
						actions={
							<OnOffToggle
								ariaLabel={`${row.label} capability`}
								disabled={disabled}
								onChange={handlers[row.key]}
								value={values[row.key]}
							/>
						}
						description={row.hint}
						key={row.key}
						title={row.label}
					/>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}

import { Add01Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import type { ModeOption } from "@/components/agent-elements/input/mode-selector.tsx";
import {
	engineForAgent,
	getAgentIcon,
	getTeamStackIcon,
} from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Team } from "@/src/lib/api/teams.ts";

/** Sentinel `ModeSelector` value that routes to the "create a new agent" flow. */
export const CREATE_AGENT_MODE = "__create_agent__";

/** Team ids are namespaced in the picker so they can't collide with agent ids. */
export const TEAM_MODE_PREFIX = "team:";

/** The "New agent…" leading icon for the agent picker's create sentinel. */
export function NewAgentModeIcon({ className }: { className?: string }) {
	return <HugeiconsIcon className={className} icon={Add01Icon} />;
}

/** The "Auto" leading icon for the composer trigger when the `auto` sentinel is active. */
export function AutoModeIcon({ className }: { className?: string }) {
	return <HugeiconsIcon className={className} icon={GitBranchIcon} />;
}

export interface ComposerAgentModesOptions {
	/** Append the "New agent…" create sentinel row. Default: true. */
	includeCreate?: boolean;
	/** Append a "Groups" section addressable as one target. Default: true. */
	includeTeams?: boolean;
}

/**
 * The composer's agent picker options, derived from the live agent/team registry
 * with each entry's engine (or team-stack) logo — never hardcoded. Agents render
 * under an "Agents" group, groups under "Groups", and an optional "New agent…"
 * sentinel closes the list.
 */
export function useComposerAgentModes(
	agents: AgentSummary[],
	teams: Team[] = [],
	{ includeTeams = true, includeCreate = true }: ComposerAgentModesOptions = {}
): ModeOption[] {
	return useMemo(() => {
		const agentOptions = agents.map<ModeOption>((a) => ({
			id: a.id,
			label: a.name,
			icon: getAgentIcon(
				a.avatarUrl,
				engineForAgent(a),
				undefined,
				undefined,
				a.avatarGlyph
			),
			description: a.description ?? undefined,
			group: "Agents",
		}));
		const teamOptions =
			includeTeams && teams.length > 0
				? teams.map<ModeOption>((t) => ({
						id: `${TEAM_MODE_PREFIX}${t.id}`,
						label: t.name,
						icon: getTeamStackIcon(
							t.members.map((id) => {
								const member = agents.find((a) => a.id === id);
								return member ? engineForAgent(member) : null;
							})
						),
						description: t.description ?? undefined,
						group: "Groups",
					}))
				: [];
		return [
			...agentOptions,
			...teamOptions,
			...(includeCreate
				? [
						{
							id: CREATE_AGENT_MODE,
							label: "New agent…",
							icon: NewAgentModeIcon,
						} satisfies ModeOption,
					]
				: []),
		];
	}, [agents, teams, includeTeams, includeCreate]);
}

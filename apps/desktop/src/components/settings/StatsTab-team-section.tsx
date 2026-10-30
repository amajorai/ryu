// The "Your Team" roster section of the Stats settings tab.

import { EmployeeBadge } from "@ryu/ui/components/employee-badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useState } from "react";
import { useAgents } from "@/src/hooks/useAgents.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import {
	type AgentProfile as AgentProfileStats,
	fetchTeamAgents,
} from "@/src/lib/api/profile.ts";
import { AgentProfile } from "./AgentProfile.tsx";
import { formatNumber } from "./StatsTab-format.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

/** Zeroed stats for a rostered agent that has no recorded usage yet. */
function emptyAgentStats(agentId: string): AgentProfileStats {
	return {
		agentId,
		hiredAt: "",
		lastActiveDay: "",
		level: 0,
		xp: 0,
		streak: { current: 0, longest: 0 },
		totals: {
			agentSeconds: 0,
			costMicroUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			sessionCount: 0,
		},
	};
}

/**
 * The "Your Team" roster: the agents-as-employees grid. Merges the Core roster
 * (identity) with the control-plane per-agent stats (usage), and drills into a
 * single agent's profile on click. Self-contained so the parent StatsTab stays
 * simple.
 */
export function TeamSection() {
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const { agents: roster, loading: rosterLoading } = useAgents();
	const teamQuery = useQuery({
		queryKey: ["profile", "team-agents"],
		queryFn: fetchTeamAgents,
	});

	const statsByAgentId = new Map(
		(teamQuery.data?.agents ?? []).map((entry) => [entry.agentId, entry])
	);
	const selectedAgent = selectedAgentId
		? roster.find((agent) => agent.id === selectedAgentId)
		: undefined;

	if (selectedAgent) {
		return (
			<AgentProfile
				agent={selectedAgent}
				key={selectedAgent.id}
				onBack={() => setSelectedAgentId(null)}
			/>
		);
	}

	return (
		<SettingsSection
			caption="Every agent you employ, with its ID badge and usage. Select one to see its full profile."
			title="Your team"
		>
			{rosterLoading ? (
				<SettingsCard>
					<SkeletonRows spacing="generous" />
				</SettingsCard>
			) : roster.length === 0 ? (
				<SettingsCard>
					<p className="text-center text-muted-foreground text-sm">
						No agents yet.
					</p>
				</SettingsCard>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{roster.map((agent) => (
						<TeamBadge
							agent={agent}
							key={agent.id}
							onSelect={() => setSelectedAgentId(agent.id)}
							stats={statsByAgentId.get(agent.id) ?? emptyAgentStats(agent.id)}
						/>
					))}
				</div>
			)}
		</SettingsSection>
	);
}

interface TeamBadgeProps {
	agent: AgentSummary;
	onSelect: () => void;
	stats: AgentProfileStats;
}

function TeamBadge({ agent, onSelect, stats }: TeamBadgeProps) {
	const { resolvedTheme } = useTheme();
	const totalTokens = stats.totals.inputTokens + stats.totals.outputTokens;
	return (
		<EmployeeBadge
			employeeId={agent.id}
			hiredAt={stats.hiredAt || undefined}
			level={stats.level}
			// The metal ring's `auto` follows the OS, which can disagree with the
			// app's own toggle — feed it the theme actually on screen.
			metalTheme={resolvedTheme === "light" ? "light" : "dark"}
			name={agent.name}
			onClick={onSelect}
			role={agent.description ?? undefined}
			stats={[
				{ label: "Tokens", value: formatNumber(totalTokens) },
				{ label: "Requests", value: formatNumber(stats.totals.requestCount) },
				{ label: "Streak", value: `${stats.streak.current}d` },
			]}
		/>
	);
}

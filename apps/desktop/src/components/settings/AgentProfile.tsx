// The per-agent profile view for the "Your Team" roster in the Stats tab.
// Given an agent's Core identity (name/description) plus its control-plane
// stats, it renders the EmployeeBadge as a header, a contributions heatmap fed
// by /api/profile/me/agents/:id/usage/daily, and a grid of lifetime stat cards.
// A back affordance returns to the roster.

import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	ContributionsGraph,
	StatCard,
} from "@ryu/ui/components/contributions-graph";
import { EmployeeBadge } from "@ryu/ui/components/employee-badge";
import { Spinner } from "@ryu/ui/components/spinner";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { useTheme } from "next-themes";
import { useMemo } from "react";
import { AgentPassportPanel } from "@/src/components/agents/AgentPassportPanel.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import {
	fetchAgentProfile,
	fetchAgentUsageDaily,
} from "@/src/lib/api/profile.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const SECONDS_PER_HOUR = 3600;
const HEATMAP_DAYS = 364;
const DATE_FORMAT = "yyyy-MM-dd";

interface AgentProfileProps {
	agent: AgentSummary;
	onBack: () => void;
}

export function AgentProfile({ agent, onBack }: AgentProfileProps) {
	const activeNode = useActiveNode();
	const activeOrgId = useActiveOrgId();
	const target = useMemo(() => toTarget(activeNode), [activeNode]);
	const organizationId = activeNode.orgId ?? activeOrgId;
	const { resolvedTheme } = useTheme();
	const { from, to } = useMemo(() => {
		const now = new Date();
		return {
			from: format(subDays(now, HEATMAP_DAYS), DATE_FORMAT),
			to: format(now, DATE_FORMAT),
		};
	}, []);

	const profileQuery = useQuery({
		queryKey: ["profile", "agent", agent.id],
		queryFn: () => fetchAgentProfile(agent.id),
	});
	const usageQuery = useQuery({
		queryKey: ["profile", "agent-usage", agent.id, from, to],
		queryFn: () => fetchAgentUsageDaily(agent.id, from, to),
	});

	const profile = profileQuery.data;
	const usageDays = usageQuery.data?.days ?? [];
	const heatmapData = usageDays.map((entry) => ({
		day: entry.day,
		count: entry.count,
	}));

	const totalTokens =
		(profile?.totals.inputTokens ?? 0) + (profile?.totals.outputTokens ?? 0);
	const hoursWorked = (profile?.totals.agentSeconds ?? 0) / SECONDS_PER_HOUR;

	const backButton = (
		<Button onClick={onBack} size="sm" variant="ghost">
			<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
			Back to team
		</Button>
	);

	if (profileQuery.isLoading) {
		return (
			<div className="space-y-4">
				{backButton}
				<div className="flex items-center justify-center py-8">
					<Spinner className="size-5" />
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{backButton}

			<div className="max-w-sm">
				<EmployeeBadge
					employeeId={agent.id}
					hiredAt={profile?.hiredAt}
					level={profile?.level ?? 0}
					metalTheme={resolvedTheme === "light" ? "light" : "dark"}
					name={agent.name}
					role={agent.description ?? undefined}
					stats={[
						{ label: "Tokens", value: formatNumber(totalTokens) },
						{
							label: "Requests",
							value: formatNumber(profile?.totals.requestCount ?? 0),
						},
						{
							label: "Streak",
							value: `${profile?.streak.current ?? 0}d`,
						},
					]}
				/>
			</div>

			<AgentPassportPanel
				agent={agent}
				organizationId={organizationId}
				target={target}
			/>

			<SettingsSection
				caption="This employee's activity over the last year."
				title="Activity"
			>
				<SettingsCard>
					<ContributionsGraph data={heatmapData} title="Daily usage" />
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Lifetime stats">
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
					<StatCard title="Total tokens" value={formatNumber(totalTokens)} />
					<StatCard title="Hours worked" value={hoursWorked.toFixed(1)} />
					<StatCard
						title="Requests"
						value={formatNumber(profile?.totals.requestCount ?? 0)}
					/>
					<StatCard title="Level" value={formatNumber(profile?.level ?? 0)} />
					<StatCard
						title="Best streak"
						value={`${profile?.streak.longest ?? 0}d`}
					/>
				</div>
			</SettingsSection>
		</div>
	);
}

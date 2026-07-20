import { useMemo } from "react";
import { CalendarContent } from "@/src/components/calendar/CalendarContent.tsx";
import { useSchedules } from "@/src/hooks/useSchedules.ts";
import { useWorkflows } from "@/src/hooks/useWorkflows.ts";

interface AgentCalendarViewProps {
	agentId: string;
}

export function AgentCalendarView({ agentId }: AgentCalendarViewProps) {
	const { jobs, loading, error, reload } = useSchedules();
	const { workflows } = useWorkflows();

	const workflowNames = useMemo(
		() => new Map(workflows.map((w): [string, string] => [w.id, w.name])),
		[workflows]
	);

	const agentJobs = useMemo(
		() =>
			jobs.filter(
				(j) => j.target.type === "agent" && j.target.agentId === agentId
			),
		[jobs, agentId]
	);

	return (
		<CalendarContent
			defaultAgentId={agentId}
			emptyDescription="Schedule this agent to run automatically — create an automation to get started."
			emptyTitle="No automations scheduled"
			error={error}
			jobs={agentJobs}
			loading={loading}
			onReload={reload}
			workflowNames={workflowNames}
		/>
	);
}

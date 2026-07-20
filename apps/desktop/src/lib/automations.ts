// apps/desktop/src/lib/automations.ts
//
// Shared "automation" helpers. The standalone Automations page was merged into
// Workflows (full collapse): scheduling an agent is modelled as a 1-node
// workflow (Input → Prompt(agent) → Output) with a `schedule` trigger, which
// Core reconciles into the same heartbeat job the old agent-target job used.
//
// This module is the single source of truth for that conversion so the two
// surfaces that create scheduled agents — the agent editor (AgentEditPage) and
// the calendar's "New automation" dialog — stay in lockstep.

import type { ApiTarget } from "./api/client.ts";
import { deleteJob, fetchJobs, type Schedule } from "./api/schedules.ts";
import {
	createWorkflow,
	fetchWorkflows,
	type WorkflowTrigger,
} from "./api/workflows.ts";

/** Friendly schedule choices offered by the schedule pickers. */
export type SchedulePhrase =
	| "everyminute"
	| "hourly"
	| "daily"
	| "weekdays"
	| "weekends"
	| "weekly"
	| "custom";

const WEEKDAY_TO_CRON: Record<string, string> = {
	monday: "1",
	tuesday: "2",
	wednesday: "3",
	thursday: "4",
	friday: "5",
	saturday: "6",
	sunday: "0",
};

/** Turn a friendly phrase + its detail controls into a Core {@link Schedule}. */
export function phraseToSchedule(
	phrase: SchedulePhrase,
	dailyTime: string,
	weeklyDay: string,
	weeklyTime: string,
	customCron: string
): Schedule {
	switch (phrase) {
		case "everyminute":
			return { kind: "every", interval: "1m" };
		case "hourly":
			return { kind: "every", interval: "1h" };
		case "daily": {
			const [hour = "9", minute = "0"] = dailyTime.split(":");
			return { kind: "cron", expr: `${minute} ${hour} * * *` };
		}
		case "weekdays": {
			const [hour = "9", minute = "0"] = dailyTime.split(":");
			return { kind: "cron", expr: `${minute} ${hour} * * 1-5` };
		}
		case "weekends": {
			const [hour = "9", minute = "0"] = dailyTime.split(":");
			return { kind: "cron", expr: `${minute} ${hour} * * 0,6` };
		}
		case "weekly": {
			const [hour = "9", minute = "0"] = weeklyTime.split(":");
			const dow = WEEKDAY_TO_CRON[weeklyDay] ?? "1";
			return { kind: "cron", expr: `${minute} ${hour} * * ${dow}` };
		}
		default:
			// "custom" (and any future phrase) falls back to the raw cron field.
			return { kind: "cron", expr: customCron };
	}
}

/** Map a {@link Schedule} onto a workflow `schedule` trigger. When
 *  `requireApproval` is set, each firing waits for a human-in-the-loop approval
 *  (an inbox request) before the workflow runs. */
export function scheduleToTrigger(
	schedule: Schedule,
	requireApproval = false
): WorkflowTrigger {
	if (schedule.kind === "cron") {
		return {
			type: "schedule",
			cron: schedule.expr,
			require_approval: requireApproval,
		};
	}
	return {
		type: "schedule",
		every: schedule.interval,
		require_approval: requireApproval,
	};
}

/** Suffix that names the workflow backing an agent's "run on a schedule" toggle.
 *  Used to match-or-update the existing one so re-saving never spawns a dupe. */
export const SCHEDULED_AGENT_SUFFIX = " (scheduled)";

/** Build the 1-node workflow definition that runs `agentId` on `schedule`:
 *  Input → Prompt(agent) → Output. Reuses `existingId` (overwrite) when set. */
export function scheduledAgentWorkflow(
	agentId: string,
	agentName: string,
	schedule: Schedule,
	existingId: string,
	requireApproval = false
): Record<string, unknown> {
	return {
		id: existingId,
		name: `${agentName}${SCHEDULED_AGENT_SUFFIX}`,
		description: "Runs this agent automatically on a schedule.",
		nodes: [
			{ id: "input", type: "input", key: null },
			{ id: "agent", type: "prompt", agent_id: agentId, prompt: "Run" },
			{ id: "output", type: "output", key: null },
		],
		edges: [
			{ from: "input", to: "agent" },
			{ from: "agent", to: "output" },
		],
		triggers: [scheduleToTrigger(schedule, requireApproval)],
	};
}

/**
 * Create (or update) the scheduled workflow that runs an agent on a schedule.
 *
 * Idempotent per agent: it matches an existing scheduled workflow for the agent
 * (a prompt node bound to the agent id + a schedule trigger) and overwrites it
 * in place, so re-saving never spawns a duplicate. It then drains any legacy
 * agent-target scheduler job for the agent (created by the retired Automations
 * page) so the agent can't double-fire.
 */
export async function createScheduledAgentWorkflow(
	target: ApiTarget,
	args: {
		agentId: string;
		agentName: string;
		schedule: Schedule;
		requireApproval?: boolean;
	}
): Promise<void> {
	const workflows = await fetchWorkflows(target);
	const existing = workflows.find(
		(w) =>
			w.triggers.some((t) => t.type === "schedule") &&
			w.nodes.some((n) => n.type === "prompt" && n.agent_id === args.agentId)
	);
	await createWorkflow(
		target,
		scheduledAgentWorkflow(
			args.agentId,
			args.agentName,
			args.schedule,
			existing?.id ?? "",
			args.requireApproval ?? false
		)
	);
	const jobs = await fetchJobs(target);
	await Promise.all(
		jobs
			.filter(
				(j) => j.target.type === "agent" && j.target.agentId === args.agentId
			)
			.map((j) => deleteJob(target, j.id).catch(() => undefined))
	);
}

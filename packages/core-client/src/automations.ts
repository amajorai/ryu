// Shared scheduled-agent routine creation.
//
// Shared "automation" helpers. The standalone Automations page was merged into
// Workflows (full collapse), but an agent schedule is a first-class heartbeat
// routine now: it owns its prompt, history, and persistent-chat destination.
//
// This module is the single source of truth for that conversion so the two
// surfaces that create scheduled agents — the agent editor (AgentEditPage) and
// the calendar's "New automation" dialog — stay in lockstep.

import type { ApiTarget } from "./client.ts";
import { createJob, type JobTarget, type Schedule } from "./schedules.ts";
import {
	deleteWorkflow,
	fetchWorkflows,
	type Workflow,
	type WorkflowTrigger,
} from "./workflows.ts";

/** Friendly schedule choices offered by the schedule pickers. */
export type SchedulePhrase =
	| "everyminute"
	| "hourly"
	| "daily"
	| "weekdays"
	| "weekends"
	| "weekly"
	| "custom";

const WEEKDAY_TO_CRON = new Map<string, string>([
	["monday", "1"],
	["tuesday", "2"],
	["wednesday", "3"],
	["thursday", "4"],
	["friday", "5"],
	["saturday", "6"],
	["sunday", "0"],
]);

/** Split an `HH:MM` picker value, defaulting each empty or missing part to
 *  9:00. A cleared time input yields `""`, which destructuring defaults would
 *  keep, producing an invalid cron such as `"0  * * *"`. */
function timeParts(time: string): [string, string] {
	const [hour, minute] = time.split(":");
	return [hour || "9", minute || "0"];
}

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
			const [hour, minute] = timeParts(dailyTime);
			return { kind: "cron", expr: `${minute} ${hour} * * *` };
		}
		case "weekdays": {
			const [hour, minute] = timeParts(dailyTime);
			return { kind: "cron", expr: `${minute} ${hour} * * 1-5` };
		}
		case "weekends": {
			const [hour, minute] = timeParts(dailyTime);
			return { kind: "cron", expr: `${minute} ${hour} * * 0,6` };
		}
		case "weekly": {
			const [hour, minute] = timeParts(weeklyTime);
			const dow = WEEKDAY_TO_CRON.get(weeklyDay) ?? "1";
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

/**
 * Create (or update) the quick agent routine used by the legacy schedule picker.
 *
 * The function name is retained for the Calendar companion bridge contract, but
 * the saved target is now a first-class agent routine. That keeps the quick
 * picker and the agent editor on the same durable-chat path as `routines.create`.
 */
export async function createScheduledAgentWorkflow(
	target: ApiTarget,
	args: {
		agentId: string;
		agentName: string;
		conversationId?: string | null;
		schedule: Schedule;
		requireApproval?: boolean;
	}
): Promise<void> {
	const routineName = `${args.agentName}${SCHEDULED_AGENT_SUFFIX}`;
	const agentTarget: JobTarget = {
		type: "agent",
		agentId: args.agentId,
		prompt: "Run",
		...(args.conversationId === undefined
			? undefined
			: { conversationId: args.conversationId }),
	};
	// Core owns the atomic per-agent slot; a client-side read then create can
	// duplicate the routine when two surfaces save concurrently.
	await createJob(target, {
		name: routineName,
		schedule: args.schedule,
		target: agentTarget,
		enabled: true,
		requireApproval: args.requireApproval ?? false,
		quickRoutine: true,
	});

	// Older versions represented this quick schedule as a tiny workflow. Delete
	// only the exact generated shape, never a user-authored workflow that merely
	// happens to call this agent.
	try {
		const workflows = await fetchWorkflows(target);
		await Promise.all(
			workflows
				.filter((workflow) =>
					isGeneratedScheduledAgentWorkflow(workflow, args.agentId)
				)
				.map((workflow) =>
					deleteWorkflow(target, workflow.id).catch(() => undefined)
				)
		);
	} catch {
		// Routine creation already succeeded. Legacy workflow cleanup is a best
		// effort migration and must not turn a working routine into a reported error
		// when the caller lacks workflow visibility on a shared node.
	}
}

function isGeneratedScheduledAgentWorkflow(
	workflow: Workflow,
	agentId: string
): boolean {
	return (
		workflow.name.endsWith(SCHEDULED_AGENT_SUFFIX) &&
		workflow.nodes.length === 3 &&
		workflow.nodes.some(
			(node) => node.type === "prompt" && node.agent_id === agentId
		) &&
		workflow.nodes.some((node) => node.type === "input") &&
		workflow.nodes.some((node) => node.type === "output") &&
		workflow.triggers.some((trigger) => trigger.type === "schedule")
	);
}

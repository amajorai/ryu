// Work an authentication request starts but never waits for: sending its
// email, and the account-dependent half of a request whose answer must not
// depend on the account (lib/email-cooldown-plugin.ts). The request answers
// first; the task runs afterwards on its own, and its failure changes nothing
// the caller sees. A failure is logged by label and error kind only, never
// with the address or the error message (which can quote the address).

import type { EmailBudget } from "./email-cooldown.ts";
import {
	currentEmailBudget,
	currentPrepaidSend,
	type PrepaidSend,
	withEmailBudget,
	withPrepaidSend,
} from "./email-send-budget.ts";

type DetachedTask = () => Promise<unknown>;

interface QueuedTask {
	budget: EmailBudget;
	label: string;
	prepaid: PrepaidSend | null;
	task: DetachedTask;
}

interface HeldQueue {
	tasks: QueuedTask[];
}

/**
 * At most this many detached tasks run at once. Answering early removes the
 * backpressure a waiting caller gave, so a flood of requests must not pile
 * up unbounded sends and replays; past the cap a task is dropped (logged by
 * label only). That is safe: its request has already been answered, and the
 * cooldown claim it made stays spent.
 */
export const MAX_DETACHED_TASKS = 256;

const running = new Set<Promise<void>>();
let droppedTasks = 0;

/** How many detached tasks the cap has dropped since this process started. */
export function droppedDetachedTasks(): number {
	return droppedTasks;
}
let held: HeldQueue | null = null;

function errorKind(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" || typeof code === "number"
			? `${error.name} (${code})`
			: error.name;
	}
	return typeof error;
}

function start({ budget, label, prepaid, task }: QueuedTask): void {
	if (running.size >= MAX_DETACHED_TASKS) {
		droppedTasks += 1;
		console.warn(
			`Detached ${label} dropped: too many detached tasks (${droppedTasks} dropped so far)`
		);
		return;
	}
	const run = (async () => {
		// Never in the caller's turn: the request has answered before this runs.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		try {
			await withPrepaidSend(prepaid, () => withEmailBudget(budget, task));
		} catch (error) {
			console.error(`Detached ${label} failed: ${errorKind(error)}`);
		}
	})();
	running.add(run);
	run.finally(() => running.delete(run));
}

/**
 * Run `task` after the current request has answered, without awaiting it. It
 * keeps the prepaid send in scope where it was started (or `prepaid` when the
 * caller names one) and that send's budget, or else the budget in scope
 * (lib/email-send-budget.ts).
 */
export function runDetached(
	label: string,
	task: DetachedTask,
	prepaid: PrepaidSend | null = currentPrepaidSend()
): void {
	const queued = {
		budget: prepaid?.budget ?? currentEmailBudget(),
		label,
		prepaid,
		task,
	};
	if (held) {
		held.tasks.push(queued);
		return;
	}
	start(queued);
}

/** Wait until every detached task started so far (and any they start) ends. */
export async function settleDetachedTasks(): Promise<void> {
	while (running.size > 0) {
		await Promise.allSettled([...running]);
	}
}

/**
 * Test seam: queue detached tasks instead of starting them, so a test can
 * observe exactly what a request did before it answered. `release` starts
 * the queued tasks and waits for them.
 */
export function holdDetachedTasks(): {
	count: () => number;
	release: () => Promise<void>;
} {
	const queue: HeldQueue = { tasks: [] };
	held = queue;
	return {
		count: () => queue.tasks.length,
		release: async () => {
			if (held === queue) {
				held = null;
			}
			for (const queued of queue.tasks.splice(0)) {
				start(queued);
			}
			await settleDetachedTasks();
		},
	};
}

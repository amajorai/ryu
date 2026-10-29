import { z } from "zod";
import type { InitialTab } from "@/src/contexts/TabsContext.tsx";

const ONBOARDING_CHAT_STATE_KEY = "ryuOnboardingChat";
const ONBOARDING_TASK_STATE_KEY = "ryuOnboardingTask";
const ONBOARDING_PROJECT_STATE_KEY = "ryuOnboardingProject";

// These are the finish-route fields we own. React Router may carry unrelated
// native values in the same state; only the owned fields affect the first tab.
function routeFieldsSchema<S extends z.ZodType>(fields: S) {
	return z.preprocess(
		(value) => (Array.isArray(value) ? { ...value } : value),
		fields
	);
}
const projectSeedSchema = routeFieldsSchema(
	z.object({
		mainThreadId: z.string().min(1),
		name: z.string().catch("Project"),
	})
);
const taskSeedSchema = routeFieldsSchema(
	z.object({
		initialPrompt: z.string().optional().catch(undefined),
		initialSubmit: z.boolean().optional().catch(undefined),
		title: z.string().optional().catch(undefined),
	})
);
const onboardingRouteStateSchema = routeFieldsSchema(
	z.object({
		[ONBOARDING_CHAT_STATE_KEY]: z.literal(true),
		[ONBOARDING_PROJECT_STATE_KEY]: z
			.union([projectSeedSchema, z.undefined()])
			.catch(undefined),
		[ONBOARDING_TASK_STATE_KEY]: z
			.union([taskSeedSchema, z.undefined()])
			.catch(undefined),
	})
);
type OnboardingRouteStateInput = Parameters<
	typeof onboardingRouteStateSchema.parse
>[0];

export const ONBOARDING_CHAT_ROUTE_STATE = {
	[ONBOARDING_CHAT_STATE_KEY]: true,
} as const;

export interface OnboardingTaskSeed {
	autoSubmit?: boolean;
	prompt: string;
	title: string;
}

export function buildOnboardingTaskRouteState(seed: OnboardingTaskSeed) {
	const chatState = { ...ONBOARDING_CHAT_ROUTE_STATE };
	const initialPrompt = seed.prompt;
	const submitState: Pick<
		z.output<typeof taskSeedSchema>,
		"initialSubmit"
	> = {};
	if (seed.autoSubmit === false) {
		submitState.initialSubmit = false;
	}
	return {
		...chatState,
		[ONBOARDING_TASK_STATE_KEY]: {
			initialPrompt,
			...submitState,
			title: seed.title,
		},
	} as const;
}

/** The project the user created in onboarding, opened when onboarding ends. */
export interface OnboardingProjectSeed {
	/** The project's coordinator main thread. */
	mainThreadId: string;
	name: string;
}

/**
 * Add the onboarding project to a finish route state, so the first screen after
 * onboarding is the project's main thread rather than an empty chat. A missing
 * project (the step was skipped or failed) leaves the state unchanged.
 */
export function withOnboardingProject<T extends object>(
	state: T,
	project: OnboardingProjectSeed | null | undefined
): T {
	if (!project?.mainThreadId) {
		return state;
	}
	return {
		...state,
		[ONBOARDING_PROJECT_STATE_KEY]: {
			mainThreadId: project.mainThreadId,
			name: project.name,
		},
	};
}

export function onboardingInitialTab(
	state: OnboardingRouteStateInput
): InitialTab | undefined {
	const parsed = onboardingRouteStateSchema.safeParse(state);
	if (!parsed.success) {
		return undefined;
	}
	const record = parsed.data;
	const task = record[ONBOARDING_TASK_STATE_KEY];
	const taskPrompt = task?.initialPrompt;
	const taskTitle = task?.title;
	const project = record[ONBOARDING_PROJECT_STATE_KEY];
	if (project) {
		// The first project's coordinator thread is home: a first task, when one
		// was picked, is sent there so the coordinator can delegate it.
		const initialTask: Pick<InitialTab, "initialPrompt" | "initialSubmit"> = {};
		if (taskPrompt) {
			initialTask.initialPrompt = taskPrompt;
			initialTask.initialSubmit = task?.initialSubmit ?? true;
		}
		return {
			conversationId: project.mainThreadId,
			...initialTask,
			path: "/chat",
			title: project.name,
		};
	}

	return {
		initialAgent: "ryu",
		...(taskPrompt
			? {
					initialPrompt: taskPrompt,
					initialSubmit: task?.initialSubmit ?? true,
				}
			: { initialProactiveOpening: true }),
		path: "/chat",
		title: taskTitle ?? "Ryu chat",
	};
}

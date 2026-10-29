import { describe, expect, test } from "bun:test";
import {
	buildOnboardingTaskRouteState,
	ONBOARDING_CHAT_ROUTE_STATE,
	onboardingInitialTab,
	withOnboardingProject,
} from "./onboarding-navigation.ts";

describe("onboarding navigation", () => {
	test("normalizes owned route fields without rejecting unrelated native state", () => {
		const state = {
			ryuOnboardingChat: true,
			ryuOnboardingTask: { initialPrompt: 3, title: "" },
			ryuOnboardingProject: { mainThreadId: "thread", name: false },
			unrelated: new Date(0),
		};
		expect(onboardingInitialTab(state)).toEqual({
			conversationId: "thread",
			path: "/chat",
			title: "Project",
		});
		expect(
			onboardingInitialTab({
				...state,
				ryuOnboardingProject: { mainThreadId: "" },
			})
		).toEqual({
			initialAgent: "ryu",
			initialProactiveOpening: true,
			path: "/chat",
			title: "",
		});
		expect(state.ryuOnboardingProject.name).toBe(false);
	});
	test("retains legacy route fields carried on arrays", () => {
		const task = Object.assign([], { initialPrompt: "Run", title: "Task" });
		const project = Object.assign([], {
			mainThreadId: "thread",
			name: "Project",
		});
		const state = Object.assign([], {
			ryuOnboardingChat: true,
			ryuOnboardingTask: task,
			ryuOnboardingProject: project,
		});
		expect(onboardingInitialTab(state)).toEqual({
			conversationId: "thread",
			initialPrompt: "Run",
			initialSubmit: true,
			path: "/chat",
			title: "Project",
		});
	});
	test("seeds the first proactive Ryu chat after onboarding", () => {
		expect(onboardingInitialTab(ONBOARDING_CHAT_ROUTE_STATE)).toEqual({
			initialAgent: "ryu",
			initialProactiveOpening: true,
			path: "/chat",
			title: "Ryu chat",
		});
	});

	test("does not seed a chat for unrelated route state", () => {
		expect(onboardingInitialTab(undefined)).toBeUndefined();
		expect(onboardingInitialTab({ ryuOnboardingChat: false })).toBeUndefined();
	});
	test("explicitly absent task and project fields preserve proactive opening", () => {
		expect(
			onboardingInitialTab({
				ryuOnboardingChat: true,
				ryuOnboardingTask: undefined,
				ryuOnboardingProject: undefined,
			})
		).toEqual({
			initialAgent: "ryu",
			initialProactiveOpening: true,
			path: "/chat",
			title: "Ryu chat",
		});
	});

	test("seeds the paid onboarding task into the first chat", () => {
		const state = buildOnboardingTaskRouteState({
			prompt: "Review my recent Chorus calls.",
			title: "Prepare Chorus follow-ups",
		});
		expect(onboardingInitialTab(state)).toEqual({
			initialAgent: "ryu",
			initialPrompt: "Review my recent Chorus calls.",
			initialSubmit: true,
			path: "/chat",
			title: "Prepare Chorus follow-ups",
		});
	});

	test("opens the first project's main thread when one was created", () => {
		const state = withOnboardingProject(ONBOARDING_CHAT_ROUTE_STATE, {
			mainThreadId: "conv-atlas",
			name: "Atlas",
		});
		expect(onboardingInitialTab(state)).toEqual({
			conversationId: "conv-atlas",
			path: "/chat",
			title: "Atlas",
		});
	});

	test("sends a picked first task into the project's main thread", () => {
		const state = withOnboardingProject(
			buildOnboardingTaskRouteState({ prompt: "Plan launch", title: "Launch" }),
			{ mainThreadId: "conv-atlas", name: "Atlas" }
		);
		expect(onboardingInitialTab(state)).toEqual({
			conversationId: "conv-atlas",
			initialPrompt: "Plan launch",
			initialSubmit: true,
			path: "/chat",
			title: "Atlas",
		});
	});

	test("a skipped project step leaves the route state unchanged", () => {
		expect(withOnboardingProject(ONBOARDING_CHAT_ROUTE_STATE, null)).toBe(
			ONBOARDING_CHAT_ROUTE_STATE
		);
	});
});

test("own-model onboarding seeds a draft without sending or starting a proactive turn", () => {
	const state = buildOnboardingTaskRouteState({
		prompt: "Use context I provide",
		title: "Plan",
		autoSubmit: false,
	});
	expect(onboardingInitialTab(state)).toEqual({
		initialAgent: "ryu",
		initialPrompt: "Use context I provide",
		initialSubmit: false,
		path: "/chat",
		title: "Plan",
	});
	expect(
		onboardingInitialTab(
			withOnboardingProject(state, { mainThreadId: "thread", name: "Project" })
		)
	).toEqual({
		conversationId: "thread",
		initialPrompt: "Use context I provide",
		initialSubmit: false,
		path: "/chat",
		title: "Project",
	});
});

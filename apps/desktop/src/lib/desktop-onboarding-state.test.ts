import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	DESKTOP_ONBOARDING_PHASE_KEY,
	getDesktopOnboardingPhase,
	isDesktopOnboardingComplete,
	markDesktopOnboardingComplete,
	persistDesktopOnboardingPhase,
	phaseAfterIntro,
	rememberNodeSetupComplete,
	resetDesktopOnboarding,
	resolveDesktopOnboardingPhase,
	shouldStartOnboarding,
	wasNodeSetupComplete,
} from "./desktop-onboarding-state.ts";

const originalStorage = globalThis.localStorage;

function storage(): Storage {
	const values = new Map<string, string>();
	return {
		clear: () => values.clear(),
		get length() {
			return values.size;
		},
		key: (index: number) => Array.from(values.keys())[index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("desktop onboarding state", () => {
	beforeEach(() => {
		globalThis.localStorage = storage();
	});

	afterEach(() => {
		globalThis.localStorage = originalStorage;
	});

	test("uses the new marker and migrates the legacy marker", () => {
		globalThis.localStorage.setItem("ryu_onboarding_complete", "true");
		expect(isDesktopOnboardingComplete()).toBe(true);
		expect(
			globalThis.localStorage.getItem("ryu_desktop_onboarding_complete")
		).toBe("true");
	});

	test("completion and reset stay desktop-local", () => {
		persistDesktopOnboardingPhase("mic");
		markDesktopOnboardingComplete();
		expect(isDesktopOnboardingComplete()).toBe(true);
		expect(globalThis.localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY)).toBe(
			null
		);
		persistDesktopOnboardingPhase("theme");
		resetDesktopOnboarding();
		expect(isDesktopOnboardingComplete()).toBe(false);
		expect(globalThis.localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY)).toBe(
			null
		);
	});

	test("restores the last durable step after an app relaunch", () => {
		persistDesktopOnboardingPhase("mic");
		expect(getDesktopOnboardingPhase()).toBe("mic");
		persistDesktopOnboardingPhase("theme");
		expect(getDesktopOnboardingPhase()).toBe("theme");
	});

	test("resumes new persona, privacy, and guidance steps after relaunch", () => {
		for (const phase of [
			"personalize-agent",
			"first-project",
			"privacy",
			"guidance",
		] as const) {
			persistDesktopOnboardingPhase(phase);
			expect(
				globalThis.localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY)
			).toBe(phase);
			expect(
				resolveDesktopOnboardingPhase({
					desktopPending: true,
					nodePending: true,
				})
			).toBe(phase);
		}
	});

	test("resumes legacy welcome checkpoints at the new guidance step", () => {
		globalThis.localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, "welcome");
		expect(getDesktopOnboardingPhase()).toBe("guidance");
		persistDesktopOnboardingPhase("guidance");
		expect(globalThis.localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY)).toBe(
			"guidance"
		);
	});

	test("resumes a legacy starting checkpoint at the welcome intro", () => {
		globalThis.localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, "starting");
		expect(getDesktopOnboardingPhase()).toBe("intro");
		expect(
			resolveDesktopOnboardingPhase({
				desktopPending: true,
				nodePending: true,
			})
		).toBe("intro");
	});

	test("hands the welcome intro off to updates in the native shell and the setup fork in a browser", () => {
		expect(phaseAfterIntro(true)).toBe("updates");
		expect(phaseAfterIntro(false)).toBe("choose");
	});

	test("restores the permission step ahead of first-run routing after relaunch", () => {
		persistDesktopOnboardingPhase("mic");
		expect(
			resolveDesktopOnboardingPhase({
				desktopPending: true,
				nodePending: true,
			})
		).toBe("mic");
	});

	test("opens a fresh first run on the welcome intro without a checkpoint", () => {
		expect(
			resolveDesktopOnboardingPhase({
				desktopPending: true,
				nodePending: true,
			})
		).toBe("intro");
		expect(
			resolveDesktopOnboardingPhase({
				desktopPending: false,
				nodePending: true,
			})
		).toBe("node-setup");
	});

	test("ignores invalid and transient checkpoints", () => {
		globalThis.localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, "not-a-step");
		expect(getDesktopOnboardingPhase()).toBeNull();

		persistDesktopOnboardingPhase("choose");
		persistDesktopOnboardingPhase("installing");
		expect(getDesktopOnboardingPhase()).toBe("choose");
	});

	test("mounts onboarding when an available node is incomplete", () => {
		expect(
			shouldStartOnboarding({
				desktopComplete: true,
				nodeCanConfigure: true,
				nodeComplete: false,
				nodeStateAvailable: true,
			})
		).toBe(true);
		expect(
			shouldStartOnboarding({
				desktopComplete: true,
				nodeComplete: true,
				nodeStateAvailable: true,
			})
		).toBe(false);
		expect(
			shouldStartOnboarding({
				desktopComplete: true,
				nodeCanConfigure: false,
				nodeComplete: false,
				nodeStateAvailable: true,
			})
		).toBe(false);
		expect(
			shouldStartOnboarding({
				desktopComplete: true,
				nodeComplete: undefined,
				nodeStateAvailable: false,
			})
		).toBe(false);
		expect(
			shouldStartOnboarding({
				desktopComplete: false,
				nodeComplete: true,
				nodeStateAvailable: true,
			})
		).toBe(true);
	});

	test("remembers node setup completion per node and forgets a regression", () => {
		expect(wasNodeSetupComplete("http://node-a")).toBe(false);
		rememberNodeSetupComplete("http://node-a", true);
		expect(wasNodeSetupComplete("http://node-a")).toBe(true);
		expect(wasNodeSetupComplete("http://node-b")).toBe(false);
		rememberNodeSetupComplete("http://node-a", false);
		expect(wasNodeSetupComplete("http://node-a")).toBe(false);
	});
});

test("fresh desktop on a configured node reaches guidance without optional device setup", () => {
	expect(
		resolveDesktopOnboardingPhase({
			desktopPending: true,
			nodePending: false,
		})
	).toBe("guidance");
});

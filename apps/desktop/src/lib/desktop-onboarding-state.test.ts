import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isDesktopOnboardingComplete,
	markDesktopOnboardingComplete,
	resetDesktopOnboarding,
	shouldStartOnboarding,
} from "./desktop-onboarding-state.ts";

const originalStorage = globalThis.localStorage;

function storage() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	};
}

describe("desktop onboarding state", () => {
	beforeEach(() => {
		globalThis.localStorage = storage() as unknown as Storage;
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
		markDesktopOnboardingComplete();
		expect(isDesktopOnboardingComplete()).toBe(true);
		resetDesktopOnboarding();
		expect(isDesktopOnboardingComplete()).toBe(false);
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
});

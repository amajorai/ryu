import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { ProjectRecord } from "./api/hierarchy.ts";
import {
	DESKTOP_ONBOARDING_PROJECT_KEY,
	resetDesktopOnboarding,
} from "./desktop-onboarding-state.ts";
import {
	bindOnboardingProjectTarget,
	clearOnboardingProjectPointer,
	OnboardingProjectMissingError,
	persistAcknowledgedOnboardingProject,
	restoreOnboardingProject,
} from "./onboarding-project-persistence.ts";

const original = globalThis.localStorage;
let refusal: "none" | "throw" | "discard" | "remove" = "none";
let values = new Map<string, string>();
let response: ProjectRecord[] = [];
let status = 200;
const calls: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		calls.push(`${request.method} ${new URL(request.url).pathname}`);
		if (
			request.method !== "GET" ||
			new URL(request.url).pathname !== "/api/projects/projects" ||
			request.headers.get("authorization") !== "Bearer private-node-token"
		) {
			return Response.json({ error: "unexpected request" }, { status: 422 });
		}
		return status === 200
			? Response.json({ projects: response })
			: Response.json({ error: "project readback refused" }, { status });
	},
});
const target = {
	url: server.url.toString(),
	token: "private-node-token",
	userJwt: null,
};
const project = {
	id: "acknowledged-project",
	name: "Authoritative name",
	description: "",
	status: "active",
	coordinatorConversationId: "authoritative-thread",
} satisfies ProjectRecord;
beforeEach(() => {
	refusal = "none";
	values = new Map([["unrelated-device-preference", "preserved"]]);
	response = [project];
	status = 200;
	calls.length = 0;
	globalThis.localStorage = {
		length: 0,
		key: () => null,
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		removeItem: (key) => {
			if (refusal !== "remove") {
				values.delete(key);
			}
		},
		setItem: (key, value) => {
			if (refusal === "throw") {
				throw new Error("device write refused");
			}
			if (refusal !== "discard") {
				values.set(key, value);
			}
		},
	};
});
afterEach(() => {
	globalThis.localStorage = original;
});
afterAll(() => server.stop(true));
test("only acknowledged identity is stored; real readback supplies current name and thread", async () => {
	const binding = await bindOnboardingProjectTarget(target, "owning-account");
	persistAcknowledgedOnboardingProject(
		{
			...project,
			name: "stale name",
			coordinatorConversationId: "stale thread",
		},
		binding
	);
	const raw = localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY) ?? "";
	expect(JSON.parse(raw)).toEqual({
		version: 1,
		projectId: project.id,
		binding,
	});
	for (const secret of [
		"private-node-token",
		"owning-account",
		"stale name",
		"stale thread",
	]) {
		expect(raw).not.toContain(secret);
	}
	expect(await restoreOnboardingProject(target, binding)).toEqual({
		name: project.name,
		mainThreadId: project.coordinatorConversationId,
	});
	expect(calls).toEqual(["GET /api/projects/projects"]);
});
test("thrown and silently discarded writes refuse continuation and exact receipt can retry", async () => {
	const binding = await bindOnboardingProjectTarget(target, "owner");
	for (const mode of ["throw", "discard"] as const) {
		refusal = mode;
		expect(() =>
			persistAcknowledgedOnboardingProject(project, binding)
		).toThrow("couldn't save");
		expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBeNull();
		expect(localStorage.getItem("unrelated-device-preference")).toBe(
			"preserved"
		);
	}
	refusal = "none";
	persistAcknowledgedOnboardingProject(project, binding);
	expect(await restoreOnboardingProject(target, binding)).toEqual({
		name: project.name,
		mainThreadId: project.coordinatorConversationId,
	});
});
test("account and node isolation clear pointer without reading the wrong authority", async () => {
	const binding = await bindOnboardingProjectTarget(target, "owner");
	for (const other of [
		await bindOnboardingProjectTarget(target, "other"),
		await bindOnboardingProjectTarget(
			{ ...target, url: "http://127.0.0.1:9" },
			"owner"
		),
	]) {
		persistAcknowledgedOnboardingProject(project, binding);
		expect(await restoreOnboardingProject(target, other)).toBeNull();
		expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBeNull();
		expect(localStorage.getItem("unrelated-device-preference")).toBe(
			"preserved"
		);
	}
	expect(calls).toEqual([]);
	expect(
		await bindOnboardingProjectTarget({ ...target, token: "rotated" }, "owner")
	).toEqual(binding);
	expect(
		await bindOnboardingProjectTarget({ ...target, token: "rotated" }, null)
	).not.toEqual(await bindOnboardingProjectTarget(target, null));
});
test("refused readback retains exact pointer; successful missing readback clears it for create or skip", async () => {
	const binding = await bindOnboardingProjectTarget(target, "owner");
	persistAcknowledgedOnboardingProject(project, binding);
	const raw = values.get(DESKTOP_ONBOARDING_PROJECT_KEY);
	status = 403;
	await expect(restoreOnboardingProject(target, binding)).rejects.toThrow();
	expect(values.get(DESKTOP_ONBOARDING_PROJECT_KEY)).toBe(raw);
	status = 200;
	expect(await restoreOnboardingProject(target, binding)).toEqual({
		name: project.name,
		mainThreadId: project.coordinatorConversationId,
	});
	response = [];
	await expect(
		restoreOnboardingProject(target, binding)
	).rejects.toBeInstanceOf(OnboardingProjectMissingError);
	expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBeNull();
	expect(localStorage.getItem("unrelated-device-preference")).toBe("preserved");
	expect(calls).toEqual(
		Array.from({ length: 3 }, () => "GET /api/projects/projects")
	);
});
test("unavailable coordinator retains pointer; checked Skip clearing and reset remove it", async () => {
	const binding = await bindOnboardingProjectTarget(target, "owner");
	persistAcknowledgedOnboardingProject(project, binding);
	const raw = localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY);
	response = [{ ...project, coordinatorConversationId: null }];
	await expect(restoreOnboardingProject(target, binding)).rejects.toThrow(
		"main thread"
	);
	expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBe(raw);
	expect(localStorage.getItem("unrelated-device-preference")).toBe("preserved");
	refusal = "remove";
	expect(clearOnboardingProjectPointer).toThrow("couldn't clear");
	expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBe(raw);
	expect(localStorage.getItem("unrelated-device-preference")).toBe("preserved");
	refusal = "none";
	clearOnboardingProjectPointer();
	expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBeNull();
	expect(localStorage.getItem("unrelated-device-preference")).toBe("preserved");
	persistAcknowledgedOnboardingProject(project, binding);
	resetDesktopOnboarding();
	expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBeNull();
	expect(localStorage.getItem("unrelated-device-preference")).toBe("preserved");
});

test("padded acknowledgement IDs are refused without overwriting a valid pointer; malformed readback retains it", async () => {
	const binding = await bindOnboardingProjectTarget(target, "owner");
	persistAcknowledgedOnboardingProject(project, binding);
	const raw = localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY);
	for (const malformed of [
		{ ...project, id: " acknowledged-project" },
		{ ...project, id: "acknowledged-project " },
		{ ...project, coordinatorConversationId: " authoritative-thread" },
		{ ...project, coordinatorConversationId: "authoritative-thread " },
	]) {
		expect(() =>
			persistAcknowledgedOnboardingProject(malformed, binding)
		).toThrow("identity");
		expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBe(raw);
	}
	expect(calls).toEqual([]);
	for (const id of [null, " authoritative-thread", "authoritative-thread "]) {
		response = [{ ...project, coordinatorConversationId: id }];
		await expect(restoreOnboardingProject(target, binding)).rejects.toThrow(
			"main thread"
		);
		expect(localStorage.getItem(DESKTOP_ONBOARDING_PROJECT_KEY)).toBe(raw);
		expect(localStorage.getItem("unrelated-device-preference")).toBe(
			"preserved"
		);
	}
	response = [project];
	expect(await restoreOnboardingProject(target, binding)).toEqual({
		name: project.name,
		mainThreadId: project.coordinatorConversationId,
	});
	expect(calls).toEqual(
		Array.from({ length: 4 }, () => "GET /api/projects/projects")
	);
});

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import { z } from "zod";
import type { ProofJsonRecord } from "./fixture-json.ts";

const EVIDENCE = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-gateway/evidence"
);
const PROJECT_TOKEN = "first-project-integration-node-token";

interface ApiCall {
	authorization: string | undefined;
	body: unknown;
	method: string;
	path: string;
}

test("real onboarding persists first-project phase, retries the node write, and hands off the acknowledged project", async ({
	page,
}, testInfo: TestInfo) => {
	const calls: ApiCall[] = [];
	const unhandledApiCalls: ApiCall[] = [];
	const pageErrors: string[] = [];
	const failedRequests: Array<{
		method: string;
		path: string;
		reason: string;
	}> = [];
	const failedResponses: Array<{
		method: string;
		path: string;
		status: number;
	}> = [];
	const projects: ProofJsonRecord[] = [];
	const preferences = new Map<string, string>();
	let projectPosts = 0;
	let releaseAcknowledgement = () => {};
	const acknowledgement = new Promise<void>((resolve) => {
		releaseAcknowledgement = resolve;
	});
	let releaseNextPost = false;

	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("requestfailed", (request) => {
		failedRequests.push({
			method: request.method(),
			path: new URL(request.url()).pathname,
			reason: request.failure()?.errorText ?? "unknown network failure",
		});
	});
	page.on("response", (response) => {
		if (response.status() >= 400) {
			failedResponses.push({
				method: response.request().method(),
				path: new URL(response.url()).pathname,
				status: response.status(),
			});
		}
	});

	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		const method = request.method();
		let body = null;
		try {
			body = request.postDataJSON();
		} catch {
			// Most reads have no body.
		}
		calls.push({
			method,
			path: url.pathname,
			authorization: request.headers().authorization,
			body,
		});
		const fulfill = <Payload>(json: Payload, status = 200) =>
			route.fulfill({ status, contentType: "application/json", json });

		if (url.pathname === "/api/projects/projects") {
			if (request.headers().authorization !== `Bearer ${PROJECT_TOKEN}`) {
				await fulfill({ error: "Unexpected project target" }, 401);
				return;
			}
			if (method === "GET") {
				await fulfill({ projects });
				return;
			}
			if (method !== "POST") {
				await fulfill({ error: "Unsupported project method" }, 405);
				return;
			}
			projectPosts += 1;
			if (projectPosts <= 2) {
				await fulfill(
					{ error: "Projects app is temporarily unavailable" },
					503
				);
				return;
			}
			if (!releaseNextPost) {
				releaseNextPost = true;
				await acknowledgement;
			}
			const submitted = z.record(z.string(), z.json()).parse(body);
			const project = {
				...submitted,
				id: "project-acknowledged-by-node",
				name: String(submitted.name ?? ""),
				status: "active",
				coordinatorConversationId: "conversation-first-project-ack",
			};
			projects.push(project);
			await fulfill(project);
			return;
		}

		if (url.pathname.startsWith("/api/preferences/")) {
			if (request.headers().authorization !== `Bearer ${PROJECT_TOKEN}`) {
				await fulfill({ error: "Unexpected preference target" }, 401);
				return;
			}
			let key: string;
			try {
				key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
			} catch {
				await fulfill({ error: "Invalid preference key" }, 400);
				return;
			}
			if (!key || key.includes("/")) {
				await fulfill({ error: "Invalid preference key" }, 400);
				return;
			}
			if (method === "GET") {
				const value = preferences.get(key);
				if (value !== undefined) {
					await fulfill({ key, value });
					return;
				}
				if (key === "default-local-agent-selection") {
					await fulfill({
						key,
						value: JSON.stringify({
							agent_id: "ryu",
							provider: "local",
							model: "gemma-4-E2B-it-Q4_K_M",
							thinking_level: "",
							effort: "",
							access_mode: "",
						}),
					});
					return;
				}
				await fulfill({ key, value: null });
				return;
			}
			const preference = z.object({ value: z.string() }).safeParse(body);
			if (method !== "PUT" || !preference.success) {
				await fulfill({ error: "Preference value must be a string" }, 400);
				return;
			}
			const value = preference.data.value;
			preferences.set(key, value);
			await fulfill({ key, value });
			return;
		}
		if (url.pathname === "/api/engines") {
			if (request.headers().authorization !== `Bearer ${PROJECT_TOKEN}`) {
				await fulfill({ error: "Unexpected engine target" }, 401);
				return;
			}
			await fulfill({ engines: [] });
			return;
		}
		if (url.pathname === "/api/engine/active") {
			if (request.headers().authorization !== `Bearer ${PROJECT_TOKEN}`) {
				await fulfill({ error: "Unexpected engine target" }, 401);
				return;
			}
			await fulfill({
				active: null,
				running: false,
				available: [],
				llamacpp_variant: null,
			});
			return;
		}
		if (url.pathname === "/api/channels" && method === "GET") {
			if (request.headers().authorization !== undefined) {
				unhandledApiCalls.push({
					method,
					path: url.pathname,
					authorization: request.headers().authorization,
					body,
				});
				await fulfill(
					{ message: "Unexpected authenticated channel-list request" },
					401
				);
				return;
			}
			// Onboarding runs before Better Auth has a session. The real channels
			// endpoint requires that session, and listChannels handles this 401.
			await fulfill({ message: "Unauthorized" }, 401);
			return;
		}
		if (url.pathname === "/api/onboarding/access") {
			await fulfill({
				allowed: true,
				managedNode: false,
				scope: "personal",
				reason: "ready",
			});
			return;
		}
		if (url.pathname === "/api/onboarding/profile/availability") {
			await fulfill({ allowed: true, completed: false, reason: "ready" });
			return;
		}
		if (url.pathname === "/api/billing/subscription-status") {
			await fulfill({ entitlement: null });
			return;
		}
		if (url.pathname === "/api/auth/get-session") {
			await fulfill({ session: null });
			return;
		}
		if (url.pathname === "/api/control-plane/orgs") {
			await fulfill({ organizations: [] });
			return;
		}
		if (url.pathname === "/api/pi-config/catalog") {
			await fulfill({ providers: [], apiTypes: [], thinkingLevels: [] });
			return;
		}
		if (url.pathname === "/api/composio/status") {
			await fulfill({ configured: false });
			return;
		}
		if (
			url.pathname.startsWith("/api/agents/") &&
			url.pathname.endsWith("/threads")
		) {
			await fulfill({ engine: "fixture", supported: false, threads: [] });
			return;
		}
		if (
			url.pathname === "/api/agents" ||
			url.pathname === "/api/agents/catalog"
		) {
			await fulfill({ agents: [], found: [], suggested: [] });
			return;
		}
		unhandledApiCalls.push({
			method,
			path: url.pathname,
			authorization: request.headers().authorization,
			body,
		});
		await fulfill(
			{ error: `No finite onboarding fixture for ${method} ${url.pathname}` },
			404
		);
	});

	try {
		await page.addInitScript(() => {
			if (!localStorage.getItem("ryu_desktop_onboarding_phase")) {
				localStorage.setItem("ryu_desktop_onboarding_phase", "first-project");
			}
			localStorage.removeItem("ryu_desktop_onboarding_complete");
		});
		await page.goto("/onboarding-first-project-integration-proof.html");
		await expect(page.getByTestId("first-project-step")).toBeVisible();
		await page
			.getByLabel("Project name", { exact: true })
			.fill("Review launch");
		await page
			.getByLabel("What is this project about?", { exact: false })
			.fill("Ship the reviewed release.");
		await page.getByRole("button", { name: /create project/i }).click();
		await expect(page.getByRole("alert")).toBeVisible();
		expect(projects).toHaveLength(0);
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(page.getByRole("alert")).toBeVisible();
		await expect.poll(() => projectPosts).toBe(2);
		expect(projects).toHaveLength(0);
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_phase")
			)
		).toBe("first-project");

		await page.reload();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_phase")
			)
		).toBe("first-project");
		await expect(page.getByTestId("first-project-step")).toBeVisible();
		await page
			.getByLabel("Project name", { exact: true })
			.fill("Review launch");
		await page
			.getByLabel("What is this project about?", { exact: false })
			.fill("Ship the reviewed release.");
		await page
			.getByRole("button", { name: "Create project", exact: true })
			.click();
		await expect.poll(() => projectPosts).toBe(3);
		await expect(
			page.getByRole("button", { name: /creating/i })
		).toBeDisabled();
		await expect.poll(() => projects.length).toBe(0);
		expect(
			calls.filter(
				(call) =>
					call.path === "/api/projects/projects" && call.method === "POST"
			)
		).toHaveLength(3);

		releaseAcknowledgement();
		// First setup keeps the built-in agent (more agents stay in the Store), so
		// the acknowledged project hands off through installing to the node's
		// local default rather than to a separate agents step.
		await expect(
			page.getByRole("heading", { name: "Set your local default" })
		).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			)
			.toBe("local-default");
		expect(projects).toEqual([
			expect.objectContaining({
				id: "project-acknowledged-by-node",
				name: "Review launch",
				description: "Ship the reviewed release.",
				coordinatorConversationId: "conversation-first-project-ack",
			}),
		]);
		// Recreate the actual app page after the parent persisted its next phase.
		// The fixture's acknowledged project remains in the node-owned store, just
		// as it would across a Desktop restart.
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "Set your local default" })
		).toBeVisible();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_phase")
			)
		).toBe("local-default");
		await page
			.getByRole("button", { name: "Save default", exact: true })
			.click();
		// The signed-out fixture has no paid entitlement and a single (empty)
		// organization list, so the saved local default hands off straight to the
		// guidance screen; provider keys, cloud default and imports are paid-only.
		await expect(page.getByTestId("onboarding-guidance-step")).toBeVisible();
		const localPreference = await page.evaluate(async (token) => {
			const response = await fetch(
				"/api/preferences/default-local-agent-selection",
				{ headers: { Authorization: `Bearer ${token}` } }
			);
			return { body: await response.json(), status: response.status };
		}, PROJECT_TOKEN);
		expect(localPreference.status).toBe(200);
		expect(localPreference.body).toEqual({
			key: "default-local-agent-selection",
			value: expect.stringContaining('"agent_id":"ryu"'),
		});
		await page
			.getByRole("button", { name: "Continue to privacy", exact: true })
			.click();
		// No OS notification choice is stored yet, so guidance asks once before
		// privacy; declining records the choice locally and continues.
		await expect(
			page.getByRole("heading", { name: "Know when your agents reply" })
		).toBeVisible();
		await page.getByRole("button", { name: "Not now", exact: true }).click();
		await expect(page.getByTestId("onboarding-final-step")).toBeVisible();
		const privacyDefaults = [
			{
				name: "Product analytics",
				key: "product-analytics-enabled",
				value: "true",
			},
			{
				name: "Community stats",
				key: "community-stats-enabled",
				value: "true",
			},
			{ name: "Crash reports", key: "crash-reports-enabled", value: "true" },
			{
				name: "Diagnostics export",
				key: "diagnostics-export-enabled",
				value: "false",
			},
		];
		for (const { name, key, value } of privacyDefaults) {
			await expect.poll(() => preferences.get(key) ?? null).toBe(null);
			await expect(
				page.getByRole("switch", { name, exact: true })
			).toHaveAttribute("aria-checked", value);
			const firstRead = calls.find(
				(call) =>
					call.method === "GET" && call.path === `/api/preferences/${key}`
			);
			expect(firstRead?.authorization).toBe(`Bearer ${PROJECT_TOKEN}`);
			const coreRead = await page.evaluate(
				async ({ token, preferenceKey }) => {
					const response = await fetch(`/api/preferences/${preferenceKey}`, {
						headers: { Authorization: `Bearer ${token}` },
					});
					return { status: response.status, body: await response.json() };
				},
				{ token: PROJECT_TOKEN, preferenceKey: key }
			);
			expect(coreRead).toEqual({ status: 200, body: { key, value: null } });
		}
		const privacySwitches = [
			{
				name: "Product analytics",
				key: "product-analytics-enabled",
				value: "false",
			},
			{
				name: "Community stats",
				key: "community-stats-enabled",
				value: "false",
			},
			{ name: "Crash reports", key: "crash-reports-enabled", value: "false" },
			{
				name: "Diagnostics export",
				key: "diagnostics-export-enabled",
				value: "true",
			},
		];
		for (const item of privacySwitches) {
			const control = page.getByRole("switch", {
				name: item.name,
				exact: true,
			});
			await expect(control).toHaveAttribute(
				"aria-checked",
				item.value === "true" ? "false" : "true"
			);
			await control.click();
			await expect(control).toHaveAttribute("aria-checked", item.value);
			await expect
				.poll(() => preferences.get(item.key) ?? null)
				.toBe(item.value);
		}
		const privacyWrites = calls.filter(
			(call) =>
				call.method === "PUT" &&
				privacySwitches.some(
					(item) => call.path === `/api/preferences/${item.key}`
				)
		);
		expect(
			privacyWrites.map(({ path: requestPath, authorization, body }) => ({
				path: requestPath,
				authorization,
				body,
			}))
		).toEqual([
			{
				path: "/api/preferences/product-analytics-enabled",
				authorization: `Bearer ${PROJECT_TOKEN}`,
				body: { value: "false" },
			},
			{
				path: "/api/preferences/community-stats-enabled",
				authorization: `Bearer ${PROJECT_TOKEN}`,
				body: { value: "false" },
			},
			{
				path: "/api/preferences/crash-reports-enabled",
				authorization: `Bearer ${PROJECT_TOKEN}`,
				body: { value: "false" },
			},
			{
				path: "/api/preferences/diagnostics-export-enabled",
				authorization: `Bearer ${PROJECT_TOKEN}`,
				body: { value: "true" },
			},
		]);
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:product-analytics-enabled")
			)
		).toBe("false");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:crash-reports-enabled")
			)
		).toBe("false");
		await page.reload();
		await expect(page.getByTestId("onboarding-final-step")).toBeVisible();
		for (const item of privacySwitches) {
			await expect(
				page.getByRole("switch", { name: item.name, exact: true })
			).toHaveAttribute("aria-checked", item.value);
			const stored = await page.evaluate(
				async ({ token, key }) => {
					const response = await fetch(`/api/preferences/${key}`, {
						headers: { Authorization: `Bearer ${token}` },
					});
					return { status: response.status, body: await response.json() };
				},
				{ token: PROJECT_TOKEN, key: item.key }
			);
			expect(stored).toEqual({
				status: 200,
				body: { key: item.key, value: item.value },
			});
		}
		expect(
			calls
				.filter(
					(call) =>
						call.path.startsWith("/api/preferences/") && call.method === "GET"
				)
				.every((call) => call.authorization === `Bearer ${PROJECT_TOKEN}`)
		).toBe(true);
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:product-analytics-enabled")
			)
		).toBe("false");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:crash-reports-enabled")
			)
		).toBe("false");
		await expect
			.poll(() =>
				page
					.getByRole("heading", { name: "Your privacy choices", exact: true })
					.evaluate((heading) => {
						for (
							let element: Element | null = heading;
							element;
							element = element.parentElement
						) {
							const style = getComputedStyle(element);
							if (
								Number(style.opacity) < 1 ||
								(style.filter !== "none" && style.filter !== "blur(0px)")
							) {
								return false;
							}
						}
						return true;
					})
			)
			.toBe(true);
		await mkdir(EVIDENCE, { recursive: true });
		// This is the actual final onboarding screen. The harness intentionally
		// keeps OnboardingPage mounted after its MemoryRouter handoff, so it does not
		// present this capture as pixels from the chat surface.
		await page.screenshot({
			path: path.join(EVIDENCE, "onboarding-first-project-privacy-step.png"),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Get started", exact: true })
			.click();
		await expect
			.poll(() => page.evaluate(() => window.__onboardingHandoff?.pathname))
			.toBe("/chat");
		const handoff = await page.evaluate(
			() =>
				/* SAFETY: onboarding-first-project-integration-proof.tsx installs __onboardingHandoff before this proof page is evaluated. */ (
					window as Window & {
						__onboardingHandoff?: {
							pathname: string;
							state: unknown;
							initialTab: unknown;
						};
					}
				).__onboardingHandoff
		);
		expect(handoff?.state).toEqual(
			expect.objectContaining({
				ryuOnboardingChat: true,
				ryuOnboardingProject: {
					mainThreadId: "conversation-first-project-ack",
					name: "Review launch",
				},
			})
		);
		expect(handoff?.initialTab).toEqual(
			expect.objectContaining({
				conversationId: "conversation-first-project-ack",
				path: "/chat",
				title: "Review launch",
			})
		);
		expect(unhandledApiCalls).toEqual([]);
		expect(
			calls.filter(
				(call) => call.method === "GET" && call.path === "/api/channels"
			)
		).toEqual([
			{
				method: "GET",
				path: "/api/channels",
				authorization: undefined,
				body: null,
			},
		]);
		expect(failedResponses).toContainEqual({
			method: "GET",
			path: "/api/channels",
			status: 401,
		});
		expect(pageErrors).toEqual([]);
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_phase")
			)
		).toBeNull();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_desktop_onboarding_complete")
			)
		).toBe("true");
	} finally {
		releaseAcknowledgement();
		await page.unrouteAll({ behavior: "wait" });
		await testInfo.attach("onboarding-browser-diagnostics.json", {
			body: Buffer.from(
				JSON.stringify(
					{ failedRequests, failedResponses, pageErrors, unhandledApiCalls },
					null,
					2
				)
			),
			contentType: "application/json",
		});
	}
});

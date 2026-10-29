import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { z } from "zod";
import {
	type PluginValue,
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import {
	responseForConsoleBootstrapRead,
	responseForConsoleNodeObservation,
} from "./console-access-app-bootstrap-contracts.ts";

const executeFile = promisify(execFile);
let nativeBootstrap: Promise<string> | undefined;
const questEventSchema = z.object({
	event: z.enum(["referral_sync", "desktop_app_opened"]),
	surface: z.literal("desktop"),
});
const presenceInputSchema = z.strictObject({
	clientId: z.string().regex(/^[a-f0-9-]{36}$/i),
	status: z.literal("online"),
});
const preferenceInputSchema = z.strictObject({ value: z.string() });
const themeNumericFieldSchema = z.number();
const emptyCustomThemesSchema = z.array(pluginValueSchema).max(0);
const themeInputSchema = pluginDocumentSchema.refine(
	(theme) =>
		Object.keys(theme).every((key) =>
			[
				"version",
				"mode",
				"lightPreset",
				"darkPreset",
				"contrast",
				"radius",
				"spacing",
				"scale",
				"cardSpacing",
				"pointerCursor",
				"chromeShadows",
				"dialogOverlayBlur",
				"popupOverlayBlur",
				"invertedBackgrounds",
				"animationsEnabled",
				"timezone",
				"locale",
				"customThemes",
			].includes(key)
		) &&
		theme.version === 1 &&
		["system", "light", "dark"].includes(String(theme.mode)) &&
		theme.lightPreset === "ryu-light" &&
		theme.darkPreset === "ryu-dark" &&
		["contrast", "radius", "spacing", "scale"].every(
			(key) => themeNumericFieldSchema.safeParse(theme[key]).success
		) &&
		emptyCustomThemesSchema.safeParse(theme.customThemes).success
);

function consoleNativeBootstrap() {
	nativeBootstrap ??= (async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), "ryu-console-native-fixture-")
		);
		const output = path.join(directory, "fixture.js");
		await executeFile("bun", [
			"build",
			path.resolve(
				import.meta.dirname,
				"console-access-native.fixture-entry.ts"
			),
			"--target=browser",
			"--format=iife",
			`--outfile=${output}`,
		]);
		return readFile(output, "utf8");
	})();
	return nativeBootstrap;
}

type ConsoleRouteOutcome =
	| { kind: "response"; response: Response }
	| { kind: "continue" }
	| { kind: "abort" };

export async function installConsoleAccessAppFixture(page: Page) {
	const fixture = createConsoleAccessCoreFixture();
	await page.addInitScript({ content: await consoleNativeBootstrap() });
	await page.route("**/*", async (route) => {
		const original = route.request();
		// The installed Playwright API owns form, empty-body and invalid-JSON decoding.
		const body =
			original.postData() === null
				? undefined
				: pluginValueSchema.parse(original.postDataJSON());
		const request = new Request(original.url(), {
			method: original.method(),
			headers: original.headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const outcome = await fixture.handle(request);
		if (outcome.kind === "continue") {
			return route.continue();
		}
		if (outcome.kind === "abort") {
			return route.abort();
		}
		return route.fulfill({
			status: outcome.response.status,
			headers: Object.fromEntries(outcome.response.headers),
			body: await outcome.response.text(),
		});
	});
	return fixture;
}

export function createConsoleAccessCoreFixture() {
	const calls: {
		path: string;
		method: string;
		origin: string;
		body: PluginValue;
		authorization?: string;
		status: number;
	}[] = [];
	const fallbackPaths = new Set<string>();
	let role: "member" | "owner" = "member";
	let failOrganizations = false;
	let holdOrganizations: Promise<void> | null = null;
	let releaseOrganizations: (() => void) | null = null;
	const handle = async (request: Request): Promise<ConsoleRouteOutcome> => {
		const url = new URL(request.url);
		const authorization = request.headers.get("authorization") ?? undefined;
		const method = request.method;
		const body =
			request.body === null
				? null
				: pluginValueSchema.parse(await request.json());
		const memberAccount = authorization === "Bearer console-member-token";
		const respond = async (json: PluginValue, status = 200) => {
			calls.push({
				path: url.pathname,
				method,
				origin: url.origin,
				body,
				authorization,
				status,
			});
			return {
				kind: "response",
				response: Response.json(json, {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			} satisfies ConsoleRouteOutcome;
		};
		// Public recent-updates feed: fetchRecentUpdates uses an unauthenticated
		// backend fetch; packages/api updatesRouter emits { items } for its feed.
		if (
			url.origin === "http://127.0.0.1:5497" &&
			method === "GET" &&
			body === null &&
			authorization === undefined &&
			url.pathname === "/api/updates/recent" &&
			[...url.searchParams].length === 1 &&
			url.searchParams.get("limit") === "8"
		) {
			return respond({ items: [] });
		}
		if (
			[
				"/api/auth/get-session",
				"/api/auth/token",
				"/api/control-plane/orgs",
				"/api/control-plane/nodes",
				"/api/control-plane/me/permissions",
			].includes(url.pathname) &&
			(method !== "GET" ||
				!["Bearer console-owner-token", "Bearer console-member-token"].includes(
					authorization ?? ""
				))
		) {
			fallbackPaths.add(`${method} ${url.pathname} invalid authority`);
			return respond({ error: "Invalid finite authority request" }, 401);
		}
		if (method === "GET" && url.pathname === "/api/auth/token" && !url.search) {
			return respond({
				token: memberAccount
					? "console-proof-member-jwt"
					: "console-proof-owner-jwt",
			});
		}
		if (
			method === "GET" &&
			url.pathname === "/api/control-plane/me/permissions" &&
			["org-a", "org-b"].includes(url.searchParams.get("orgId") ?? "") &&
			[...url.searchParams].length === 1
		) {
			return respond({
				permissions:
					!memberAccount &&
					role === "owner" &&
					url.searchParams.get("orgId") === "org-a"
						? ["gateway.configure"]
						: [],
			});
		}
		if (
			method === "POST" &&
			!url.search &&
			url.pathname === "/api/quests/events" &&
			[
				JSON.stringify({ event: "referral_sync", surface: "desktop" }),
				JSON.stringify({ event: "desktop_app_opened", surface: "desktop" }),
			].includes(JSON.stringify(body))
		) {
			return respond({
				ok: true,
				accepted: true,
				...questEventSchema.parse(body),
			});
		}
		if (
			method === "POST" &&
			!url.search &&
			url.pathname === "/api/billing/trial" &&
			body === null
		) {
			return respond({ firstLaunchAt: "2026-10-05T00:00:00Z" });
		}
		if (
			method === "POST" &&
			!url.search &&
			url.pathname === "/api/ws/ticket" &&
			JSON.stringify(body) ===
				JSON.stringify({
					kind: "conversation",
					roomId: "system:plugins",
					route: "realtime",
				})
		) {
			// This finite transport has no realtime server. Refuse rather than invent
			// a successful ticket/socket round trip outside this access proof.
			return respond(
				{ error: "Realtime is unavailable in the local access fixture" },
				503
			);
		}
		if (
			method === "PUT" &&
			!url.search &&
			url.pathname === "/api/presence" &&
			presenceInputSchema.safeParse(body).success
		) {
			return respond({
				status: "online",
				source: "reported",
				questionsDeferred: false,
				gaming: {
					active: false,
					detectedGame: null,
					modelsPaused: false,
					settings: {
						detectionEnabled: false,
						extraProcesses: [],
						ignoredProcesses: [],
						freeLocalModels: false,
					},
				},
				streaming: {
					active: false,
					detectedApp: null,
					settings: { apps: [], detectionEnabled: false, schemaVersion: 1 },
				},
			});
		}
		if (
			method === "PUT" &&
			!url.search &&
			url.pathname === "/api/preferences/theme"
		) {
			const preference = preferenceInputSchema.safeParse(body);
			if (
				preference.success &&
				themeInputSchema.safeParse(JSON.parse(preference.data.value)).success
			) {
				return respond({ ok: true, key: "theme" });
			}
		}
		if (url.pathname === "/api/auth/logout" && method === "POST") {
			return respond({ ok: true });
		}
		if (url.pathname === "/api/auth/get-session") {
			return respond({
				session: {
					id: memberAccount ? "session-member" : "session-owner",
					token: memberAccount ? "console-member-token" : "console-owner-token",
					userId: memberAccount ? "member-two" : "owner-one",
					activeOrganizationId: "org-a",
					expiresAt: "2099-01-01T00:00:00Z",
				},
				user: {
					id: memberAccount ? "member-two" : "owner-one",
					name: memberAccount ? "Member Two" : "Owner One",
					email: memberAccount ? "member@example.test" : "owner@example.test",
					image: null,
					isAnonymous: false,
					waitlistStatus: "approved",
				},
			});
		}
		if (url.pathname === "/api/control-plane/orgs") {
			const responseRole = memberAccount ? "member" : role;
			const failed = failOrganizations;
			await holdOrganizations;
			return respond(
				failed
					? { error: "Organization access unavailable" }
					: {
							organizations: [
								{
									id: "org-a",
									name: "Organization A",
									slug: "a",
									role: responseRole,
								},
								{
									id: "org-b",
									name: "Organization B",
									slug: "b",
									role: "member",
								},
							],
						},
				failed ? 503 : 200
			);
		}
		if (url.pathname === "/api/control-plane/nodes") {
			return respond({
				nodes: ["a", "b"].map((name) => ({
					id: `managed-${name}`,
					name: `Managed ${name.toUpperCase()}`,
					url: `http://managed-${name}.example.test`,
					orgId: `org-${name}`,
					orgName: `Organization ${name.toUpperCase()}`,
					lastSeenAt: null,
					userJwt: `delegation-${name}`,
					scope: "org",
				})),
			});
		}
		if (url.pathname === "/api/billing/subscription-status") {
			return respond({
				entitlement: {
					desktopAccess: true,
					managedInference: true,
					marketplaceApps: true,
					monthlyCreditPoolMicroUsd: 15_000_000,
					plan: "pro",
					seats: 1,
				},
				plan: "pro",
				subscription: {
					status: "active",
					interval: "month",
					currentPeriodEnd: "2099-01-01T00:00:00Z",
				},
			});
		}
		if (url.pathname === "/api/credits/wallet") {
			return respond({
				wallet: {
					id: "wallet-proof",
					ownerId: "org-a",
					subscriptionBalanceMicroUsd: null,
					topupBalanceMicroUsd: null,
					balanceMicroUsd: 1_000_000,
					currency: "USD",
					ownerType: "org",
					updatedAt: "2026-10-05T00:00:00Z",
				},
				ledger: [],
			});
		}
		if (url.pathname === "/api/onboarding/state") {
			return respond({
				completed: true,
				completedAtMs: 1,
				personalization: { companyContext: "", companyKnowledgeEnabled: false },
				setupKind: "personal",
				version: 1,
				canConfigure: false,
			});
		}
		if (url.pathname === "/api/waitlist/me") {
			return respond({ status: "approved" });
		}
		if (
			method === "GET" &&
			url.pathname === "/api/quests" &&
			!url.search &&
			[
				"http://managed-a.example.test",
				"http://managed-b.example.test",
			].includes(url.origin)
		) {
			return respond({ quests: [] });
		}
		const reads = new Map<string, PluginValue>(
			Object.entries<PluginValue>({
				"/api/health": { status: "ok", version: "1.0.0", capabilities: [] },
				"/api/plugins": { apps: [] },
				"/api/plugins/contributions": {
					companions: [],
					agent_edit_panels: [],
					backgrounds: [],
				},
				"/api/agents": { agents: [] },
				"/api/engines": { engines: [] },
				"/api/engine/active": { active: "", available: [], running: false },
				"/api/engines/models": { models: {} },
				"/api/spaces": { spaces: [] },
				"/api/skills": { skills: [] },
				"/api/composio/status": { configured: false, base_url: "" },
				"/api/models/installed": { models: [] },
				// Existing node-owned paid cloud default. Bot's real adoption read keeps it.
				"/api/preferences/default-cloud-agent-selection": {
					value: JSON.stringify({
						agent_id: "ryu",
						provider: "managed-openrouter",
						model: "openrouter/auto",
						thinking_level: "",
						effort: "",
						access_mode: "",
					}),
				},
			})
		);
		if (method === "GET" && !url.search && reads.has(url.pathname)) {
			return respond(reads.get(url.pathname) ?? null);
		}
		if (
			method === "PUT" &&
			[
				"/api/preferences/entitlement-active",
				"/api/preferences/managed-inference-entitled",
			].includes(url.pathname) &&
			!url.search
		) {
			const expected = "true";
			if (JSON.stringify(body) === JSON.stringify({ value: expected })) {
				return respond({
					ok: true,
					key: url.pathname.slice(url.pathname.lastIndexOf("/") + 1),
				});
			}
		}
		if (
			method === "GET" &&
			body === null &&
			((url.pathname === "/api/login-approvals/stream" && !url.search) ||
				(url.pathname === "/api/notifications/stream" &&
					[...url.searchParams].length === 1 &&
					["owner-one", "member-two"].includes(
						url.searchParams.get("user_id") ?? ""
					)))
		) {
			return {
				kind: "response",
				response: new Response(": fixture idle\n\n", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			};
		}
		if (
			method === "GET" &&
			body === null &&
			!url.search &&
			[
				"/api/events",
				"/api/events/all",
				"/api/runs/stream",
				"/api/notifications/stream",
				"/api/credits/wallet/stream",
				"/api/credits/alert/stream",
			].includes(url.pathname)
		) {
			return {
				kind: "response",
				response: new Response(": fixture idle\n\n", {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			};
		}
		if (method === "GET" && body === null) {
			const observation = responseForConsoleNodeObservation(
				url,
				method,
				authorization,
				body
			);
			if (observation !== undefined) {
				return respond(observation);
			}
			const bootstrap = responseForConsoleBootstrapRead(url);
			if (bootstrap !== undefined) {
				return respond(bootstrap);
			}
		}
		if (url.pathname.startsWith("/api/")) {
			fallbackPaths.add(`${method} ${url.pathname}${url.search}`);
			return respond({ error: "Unknown finite Console proof contract" }, 500);
		}
		if (url.origin === "http://127.0.0.1:5497") {
			return { kind: "continue" };
		}
		return { kind: "abort" };
	};
	return {
		handle,
		setRole: (next: "member" | "owner") => {
			role = next;
		},
		setFailure: (failed: boolean) => {
			failOrganizations = failed;
		},
		hold: () => {
			holdOrganizations = new Promise<void>((resolve) => {
				releaseOrganizations = resolve;
			});
		},
		release: () => {
			holdOrganizations = null;
			releaseOrganizations?.();
			releaseOrganizations = null;
		},
		snapshot: () => ({ calls: [...calls], fallbackPaths: [...fallbackPaths] }),
	};
}

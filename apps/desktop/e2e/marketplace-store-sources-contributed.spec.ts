import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { z } from "zod";
import type {
	PluginContributions,
	PluginStoreTab,
} from "../src/lib/api/plugins.ts";

const STORY = "/marketplace-store-sources-contributed.html";
const evidence = resolve(
	process.env.RYU_STORE_TEST_PROOF_DIR ??
		resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/parallel/marketplace-assets/store-sources-contributed"
		)
);
const diagnostics = new WeakMap<
	Page,
	{
		errors: string[];
		unknown: string[];
		calls: {
			method: string;
			path: string;
			search: string;
			auth?: string;
			body: unknown;
		}[];
		origin: string;
	}
>();
const emptyContributions = {
	agent_edit_panels: [],
	composer_controls: [],
	chat_features: [],
	chat_widget_templates: [],
	settings_tabs: [],
	message_actions: [],
	selection_actions: [],
	output_styles: [],
	context_menu_items: [],
	create_actions: [],
	slash_commands: [],
	turn_hooks: [],
	hook_events: [],
	views: [],
	sidebar_sections: [],
	sidebar_modes: [],
	sidebar_buttons: [],
	themes: [],
	dock_panels: [],
	live_activities: [],
	store_tabs: [],
	channels: [],
	companions: [],
	widget_apps: [],
} satisfies PluginContributions;
test.beforeEach(async ({ page, baseURL }) => {
	const state: Parameters<typeof diagnostics.set>[1] = {
		errors: [],
		unknown: [],
		calls: [],
		origin: new URL(baseURL!).origin,
	};
	diagnostics.set(page, state);
	page.on("pageerror", (error) => state.errors.push(error.message));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			return;
		}
		let body = null;
		try {
			body = request.postDataJSON();
		} catch {
			body = request.postData();
		}
		state.calls.push({
			method: request.method(),
			path: url.pathname,
			search: url.search,
			auth: request.headers().authorization,
			body,
		});
	});
});
test.afterEach(async ({ page }, testInfo) => {
	const state = diagnostics.get(page)!;
	mkdirSync(evidence, { recursive: true });
	writeFileSync(
		resolve(
			evidence,
			`${testInfo.title.replace(/[^a-z0-9]+/gi, "-")}-contracts.json`
		),
		JSON.stringify(state, null, 2)
	);
	expect(
		state.unknown,
		"all source/contributed API calls must have explicit fixtures"
	).toEqual([]);
	expect(state.errors, "uncaught production errors").toEqual([]);
});
const plugin = "com.ryu.store-proof";
const catalogPath = `/api/ext/${plugin}/catalog`;
const tab: PluginStoreTab = {
	app_enabled: true,
	app_installed: true,
	id: "proof",
	plugin,
	title: "Local templates",
	http_policy: "owner",
	spec: {
		source: { http: { method: "GET", path: catalogPath }, items: "items" },
		map: {
			id: "id",
			title: "name",
			description: "description",
			installed: "installed",
		},
		install: {
			label: "Use",
			http: {
				method: "POST",
				path: `${catalogPath}/{{item.id}}/install`,
				body: { template_id: "{{item.id}}" },
			},
		},
	},
};

test("Marketplaces retains custom source after removal refusal and reads back retry", async ({
	page,
}) => {
	let removed = false;
	let attempts = 0;
	let reads = 0;
	const mutations: unknown[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (
				url.pathname === "/api/catalog/sources" &&
				request.method() === "GET"
			) {
				reads++;
				const kind = url.searchParams.get("kind");
				return json(route, {
					kind,
					active: "builtin",
					sources: [
						{ id: "builtin", display_name: "Managed source", builtin: true },
						...(kind === "plugin" && !removed
							? [
									{
										id: "custom",
										display_name: "Local custom source",
										builtin: false,
									},
								]
							: []),
					],
				});
			}
			if (
				url.pathname === "/api/catalog/sources" &&
				request.method() === "DELETE"
			) {
				mutations.push(request.postDataJSON());
				expect(request.headers().authorization).toBe(
					"Bearer fixture-node-token"
				);
				attempts++;
				if (attempts === 1) {
					return json(route, { ok: false, error: "Removal policy denied" });
				}
				removed = true;
				return json(route, { ok: true });
			}
			return json(route, { error: `Unexpected ${url.pathname}` }, 500);
		}
	);
	await page.goto(`${STORY}?section=marketplaces`);
	await expect(
		page.getByText("Local custom source", { exact: true })
	).toBeVisible();
	const initialReads = reads;
	await page
		.getByRole("button", { name: "Remove Local custom source" })
		.click();
	await expect(
		page.getByText("Removal policy denied", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Local custom source", { exact: true })
	).toBeVisible();
	expect(reads).toBe(initialReads);
	await expect(
		page.getByText("Marketplace removed", { exact: true })
	).toHaveCount(0);
	await proof(page, "marketplaces-removal-refusal.png");
	await page
		.getByRole("button", { name: "Remove Local custom source" })
		.click();
	await expect(
		page.getByText("Local custom source", { exact: true })
	).toHaveCount(0);
	expect(mutations).toEqual([
		{ id: "custom", kind: "plugin" },
		{ id: "custom", kind: "plugin" },
	]);
	expect(reads).toBeGreaterThan(initialReads);
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Marketplaces", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Local custom source", { exact: true })
	).toHaveCount(0);
	await proof(page, "marketplaces-removal-readback.png");
});
async function json<Payload>(route: Route, value: Payload, status = 200) {
	const request = route.request();
	const state = diagnostics.get(request.frame().page())!;
	expect(new URL(request.url()).origin).toBe(state.origin);
	expect(request.headers().authorization).toBe("Bearer fixture-node-token");
	if (
		z.object({ error: z.string().startsWith("Unexpected") }).safeParse(value)
			.success
	) {
		state.unknown.push(`${request.method()} ${request.url()}`);
	}
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(value),
	});
}
async function proof(page: Page, name: string) {
	mkdirSync(evidence, { recursive: true });
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({
		path: resolve(evidence, name),
		fullPage: true,
		animations: "disabled",
	});
}
async function expectInstalledTemplate(page: Page) {
	const detail = page.getByRole("dialog", { name: "Verified template" });
	await expect(
		detail.getByText("Added", { exact: true }).first()
	).toBeVisible();
	await expect(
		detail.getByRole("button", { name: "Use", exact: true })
	).toHaveCount(0);
	await detail.getByRole("button", { name: "Close", exact: true }).click();
	await expect(detail).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
}

test("disabled contributed app refuses enable without success/readback, then retries", async ({
	page,
}) => {
	let enabled = false;
	let attempts = 0;
	let contributionReads = 0;
	const calls: { path: string; method: string; auth: string | undefined }[] =
		[];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname;
			calls.push({
				path,
				method: request.method(),
				auth: request.headers().authorization,
			});
			if (path === "/api/plugins/contributions" && request.method() === "GET") {
				contributionReads++;
				return json(route, {
					...emptyContributions,
					store_tabs: [{ ...tab, app_enabled: enabled }],
				});
			}
			if (path === "/api/plugins" && request.method() === "GET") {
				return json(route, { apps: [] });
			}
			if (
				path === `/api/plugins/${plugin}/enable` &&
				request.method() === "POST"
			) {
				expect(request.postData()).toBeNull();
				attempts++;
				if (attempts === 1) {
					return json(
						route,
						{ error: "Enable permission denied", denied_grants: ["network"] },
						403
					);
				}
				enabled = true;
				return json(route, {
					app: {
						id: plugin,
						version: "1.0.0",
						enabled: true,
						approved_grants: [],
						created_at: "now",
						updated_at: "now",
					},
				});
			}
			if (path === catalogPath && request.method() === "GET") {
				return json(route, {
					items: [
						{
							id: "one",
							name: "Verified template",
							description: "Loaded after successful enable.",
							installed: false,
						},
					],
				});
			}
			return json(route, { error: `Unexpected ${path}` }, 500);
		}
	);
	await page.goto(STORY);
	await expect(
		page.getByText("Turn on Local templates", { exact: true })
	).toBeVisible();
	const readsBefore = contributionReads;
	await page.getByRole("button", { name: "Enable", exact: true }).click();
	await expect(
		page.getByText("Couldn't enable the app", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Gateway denied grants: network", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Turn on Local templates", { exact: true })
	).toBeVisible();
	expect(contributionReads).toBe(readsBefore);
	expect(calls.filter((call) => call.path === catalogPath)).toEqual([]);
	await expect(
		page.getByText("Local templates is ready", { exact: true })
	).toHaveCount(0);
	await proof(page, "contributed-enable-refusal.png");
	await page.getByRole("button", { name: "Enable", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /Verified template/ })
	).toBeVisible();
	expect(attempts).toBe(2);
	expect(calls.filter((call) => call.path.endsWith("/enable"))).toEqual(
		Array.from({ length: 2 }, () => ({
			path: `/api/plugins/${plugin}/enable`,
			method: "POST",
			auth: "Bearer fixture-node-token",
		}))
	);
	await page.reload();
	await expect(
		page.getByRole("button", { name: /Verified template/ })
	).toBeVisible();
	await expect(
		page.getByText("Turn on Local templates", { exact: true })
	).toHaveCount(0);
	expect(attempts).toBe(2);
	await proof(page, "contributed-enable-retry.png");
});

test("contributed catalog read and install refusal retry follows server installed readback", async ({
	page,
}) => {
	let reads = 0;
	let installs = 0;
	let installed = false;
	const bodies: unknown[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname;
			if (path === "/api/plugins/contributions" && request.method() === "GET") {
				return json(route, { ...emptyContributions, store_tabs: [tab] });
			}
			if (path === "/api/plugins" && request.method() === "GET") {
				return json(route, { apps: [] });
			}
			if (path === catalogPath && request.method() === "GET") {
				reads++;
				if (reads === 1) {
					return json(route, { error: "Read unavailable" }, 503);
				}
				return json(route, {
					items: [
						{
							id: "one",
							name: "Verified template",
							description: "Local deterministic template.",
							installed,
						},
					],
				});
			}
			if (
				path === `${catalogPath}/one/install` &&
				request.method() === "POST"
			) {
				expect(request.headers().authorization).toBe(
					"Bearer fixture-node-token"
				);
				bodies.push(request.postDataJSON());
				installs++;
				if (installs === 1) {
					return json(route, { error: "Install denied" }, 403);
				}
				installed = true;
				return json(route, { workflow_id: "created-one" });
			}
			return json(route, { error: `Unexpected ${path}` }, 500);
		}
	);
	await page.goto(STORY);
	await expect(
		page.getByText("Couldn't load Local templates", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await page.getByRole("button", { name: /Verified template/ }).click();
	const readsBeforeInstall = reads;
	await page.getByRole("button", { name: "Use", exact: true }).last().click();
	await expect(
		page.getByText(`${catalogPath}/one/install failed: 403`, { exact: true })
	).toBeVisible();
	expect(installed).toBe(false);
	expect(reads).toBe(readsBeforeInstall);
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toHaveCount(0);
	await proof(page, "contributed-install-refusal.png");
	await page.getByRole("button", { name: "Use", exact: true }).last().click();
	await expectInstalledTemplate(page);
	expect(bodies).toEqual([{ template_id: "one" }, { template_id: "one" }]);
	expect(reads).toBeGreaterThanOrEqual(3);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
	await proof(page, "contributed-install-readback.png");
});

test("StorePage discovers enabled contributions, dispatches installation and protects built-in sections", async ({
	page,
}) => {
	let installed = false;
	let reads = 0;
	const installBodies: unknown[] = [];
	const declaration = (
		id: string,
		title: string,
		appInstalled: boolean,
		appEnabled: boolean
	): PluginStoreTab => ({
		...tab,
		id,
		title,
		app_installed: appInstalled,
		app_enabled: appEnabled,
		spec: {
			...tab.spec,
			source: {
				http: { method: "GET", path: `${catalogPath}/${id}` },
				items: "items",
			},
		},
	});
	const disabled = declaration("disabled", "Disabled templates", true, false);
	const uninstalled = declaration(
		"uninstalled",
		"Uninstalled templates",
		false,
		true
	);
	const collision = declaration("marketplaces", "Hijacked sources", true, true);
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const path = url.pathname;
			if (request.method() === "GET") {
				expect(request.postData()).toBeNull();
				if (path === "/api/plugins/contributions") {
					return json(route, {
						...emptyContributions,
						store_tabs: [tab, disabled, uninstalled, collision],
					});
				}
				if (path === catalogPath) {
					reads++;
					return json(route, {
						items: [
							{
								id: "one",
								name: "Verified template",
								description: "Dispatched by the real Store host.",
								installed,
							},
						],
					});
				}
				if (path === `${catalogPath}/marketplaces`) {
					return json(route, {
						items: [
							{ id: "collision", name: "Collision template", installed: false },
						],
					});
				}
				if (path === "/api/catalog/sources") {
					const kind = url.searchParams.get("kind");
					expect([
						"plugin",
						"skill",
						"mcp",
						"model",
						"knowledge",
						"agent",
					]).toContain(kind);
					return json(route, {
						kind,
						active: "builtin",
						sources: [
							{ id: "builtin", display_name: "Managed source", builtin: true },
						],
					});
				}
				// Finite envelopes decoded by the actual Store prefetch/count callers.
				const responses = new Map(
					Object.entries({
						"/api/plugins": { apps: [] },
						"/api/plugins/catalog/browse": {
							entries: [],
							next_cursor: null,
							total: 0,
							app_total: 0,
							plugin_total: 0,
						},
						"/api/skills/catalog": { skills: [], next_cursor: null, total: 0 },
						"/api/skills": { skills: [] },
						"/api/skills/packs": { packs: [] },
						"/api/mcp/catalog": { servers: [], next_cursor: null, total: 0 },
						"/api/mcp/servers": { servers: [] },
						"/api/agents/catalog": { agents: [] },
						"/api/integrations": {
							integrations: [],
							next_cursor: null,
							total: 0,
						},
						"/api/models/catalog": { models: [], next_cursor: null, total: 0 },
						"/api/catalog": { sidecars: [] },
						"/api/sandbox/backend": { active: "wasmtime", available: [] },
					})
				);
				if (responses.has(path)) {
					return json(route, responses.get(path));
				}
			}
			if (
				request.method() === "POST" &&
				path === `${catalogPath}/one/install`
			) {
				const body = request.postDataJSON();
				expect(body).toEqual({ template_id: "one" });
				installBodies.push(body);
				if (installBodies.length === 1) {
					return json(route, { error: "Install denied" }, 403);
				}
				installed = true;
				return json(route, { workflow_id: "created-one" });
			}
			return json(
				route,
				{ error: `Unexpected ${request.method()} ${path}` },
				501
			);
		}
	);
	await page.goto(`${STORY}?host=store&section=marketplaces`);
	const marketplacePill = page.getByRole("tab", { name: /^Marketplaces/ });
	const contributedPill = page.getByRole("tab", { name: /^Local templates/ });
	await expect(
		page.getByRole("heading", { name: "Marketplaces", exact: true })
	).toBeVisible();
	await expect(contributedPill).toBeVisible();
	await expect(marketplacePill).toHaveCount(1);
	for (const title of [disabled.title, uninstalled.title, collision.title]) {
		await expect(page.getByRole("tab", { name: title })).toHaveCount(0);
		await expect(
			page.getByText(`Turn on ${title}`, { exact: true })
		).toHaveCount(0);
	}
	await expect(
		page.getByRole("button", { name: /Collision template/ })
	).toHaveCount(0);
	await contributedPill.click();
	await expect(contributedPill).toHaveAttribute("aria-selected", "true");
	await page.getByRole("button", { name: /Verified template/ }).click();
	const readsBeforeInstall = reads;
	await page.getByRole("button", { name: "Use", exact: true }).last().click();
	await expect(
		page.getByText(`${catalogPath}/one/install failed: 403`, { exact: true })
	).toBeVisible();
	expect(installed).toBe(false);
	expect(reads).toBe(readsBeforeInstall);
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toHaveCount(0);
	await proof(page, "store-host-contributed-install-refusal.png");
	await page.getByRole("button", { name: "Use", exact: true }).last().click();
	await expectInstalledTemplate(page);
	expect(reads).toBeGreaterThan(readsBeforeInstall);
	expect(installBodies).toEqual([
		{ template_id: "one" },
		{ template_id: "one" },
	]);
	await page.reload();
	await contributedPill.click();
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
	await proof(page, "store-host-contributed-install-readback.png");
	await marketplacePill.click();
	await expect(marketplacePill).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByRole("heading", { name: "Marketplaces", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Collision template/ })
	).toHaveCount(0);
	const calls = diagnostics.get(page)!.calls;
	expect(
		calls.filter(
			(call) =>
				call.path.endsWith("/enable") ||
				call.path === `${catalogPath}/disabled` ||
				call.path === `${catalogPath}/uninstalled`
		)
	).toEqual([]);
	expect(
		calls.filter((call) => call.path === "/api/plugins/contributions").length
	).toBeGreaterThanOrEqual(2);
	await proof(page, "store-host-built-in-section-protected.png");
});

import { expect, test, type Page } from "@playwright/test";

import { createVersionEntitlementPreferences } from "./agent-version-entitlement-fixture.ts";

const AGENT = "version-proof";
const VERSION = "baseline / immutable";
const PATH = `/api/agents/${AGENT}`;
const RESTORE = `${PATH}/versions/${encodeURIComponent(VERSION)}/restore`;
const baseline = {
	id: AGENT,
	name: "Checkpoint agent",
	title: "Saved badge",
	description: "Saved description",
	system_prompt: "Use the immutable checkpoint instructions.",
	engine: "acp:pi",
	model: "checkpoint-model",
	chat_model: { engine: "fixture-provider", model_id: "checkpoint-model" },
	tools: ["web.search"],
	skills: ["checkpoint-skill"],
	composio_actions: [],
	identity_profile_ids: [],
	memory: {
		space_ids: ["saved-space"],
		read_levels: ["user"],
		write_enabled: true,
	},
	persona: {
		display_name: "Checkpoint persona",
		tone: "technical",
		output_style_id: null,
	},
	inference: { temperature: 0.27 },
	orchestrator: false,
	can_create_agents: true,
	safety_profile: "approval_required",
	built_in: false,
	locked: false,
	version: "1.2.3",
	lifecycle_status: "active",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};
const initial = {
	...baseline,
	name: "Current agent",
	description: "Current description",
	system_prompt: "Current instructions.",
	model: "current-model",
	chat_model: { engine: "fixture-provider", model_id: "current-model" },
	tools: ["terminal.execute"],
	skills: ["current-skill"],
	persona: {
		display_name: "Current persona",
		tone: "neutral",
		output_style_id: null,
	},
	version: "2.0.0",
};
type Call = {
	scope: string;
	method: string;
	path: string;
	body: unknown;
	authorization: string | undefined;
	jwt: string | undefined;
};
async function install(page: Page) {
	const immutable = structuredClone(baseline);
	let current = structuredClone(initial);
	let refuse = false;
	let held: Promise<void> | null = null;
	let release = () => {};
	const entitlementPreferences = createVersionEntitlementPreferences();
	const calls: Call[] = [];
	const errors: string[] = [];
	const unexpected: Call[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/scope-*/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const scope = url.pathname.startsWith("/scope-b/") ? "b" : "a";
		const path = url.pathname.replace(/^\/scope-[ab]/, "");
		const method = request.method();
		const headers = request.headers();
		const call: Call = {
			scope,
			path,
			method,
			body: request.postData() ? request.postDataJSON() : null,
			authorization: headers.authorization,
			jwt: headers["x-ryu-user-jwt"],
		};
		calls.push(call);
		if (
			call.authorization !== `Bearer version-bearer-${scope}` ||
			call.jwt !== `version-user-${scope}`
		) {
			unexpected.push(call);
			await route.fulfill({
				status: 403,
				json: { error: "Fixture authority refused" },
			});
			return;
		}
		const fulfill = (json: unknown, status = 200) =>
			route.fulfill({ status, json });
		const preference = entitlementPreferences.handle(
			scope,
			method,
			path,
			call.body,
		);
		if (preference) {
			await fulfill(preference.body, preference.status);
			return;
		}

		if (path === RESTORE && method === "POST") {
			if (held) await held;
			if (refuse) {
				refuse = false;
				await fulfill(
					{ error: "Version restore refused; retry the checkpoint" },
					503,
				);
				return;
			}
			current = structuredClone(immutable);
			await fulfill({ agent: current, source: JSON.stringify(current) });
			return;
		}
		if (path === PATH && method === "GET") {
			await fulfill({
				agent: scope === "b" ? { ...initial, name: "Scope B agent" } : current,
				source: JSON.stringify(
					scope === "b" ? { ...initial, name: "Scope B agent" } : current,
				),
			});
			return;
		}
		if (path === PATH && method === "PUT") {
			current = { ...current, ...(call.body as typeof current) };
			await fulfill({ agent: current, source: JSON.stringify(current) });
			return;
		}
		if (path === `${PATH}/versions` && method === "GET") {
			await fulfill({
				versions: [
					{
						id: VERSION,
						agent_id: AGENT,
						created_at: 1,
						label: "Immutable checkpoint",
						name: immutable.name,
						version: immutable.version,
					},
				],
			});
			return;
		}
		if (
			path === `${PATH}/versions/${encodeURIComponent(VERSION)}` &&
			method === "GET"
		) {
			await fulfill({
				version: { agent: immutable, source: JSON.stringify(immutable) },
			});
			return;
		}
		if (method !== "GET") {
			unexpected.push(call);
			await fulfill({ error: "Unexpected fixture mutation" }, 400);
			return;
		}
		if (path === "/api/agents") {
			await fulfill({
				agents: [
					current,
					{
						id: "ryu",
						name: "Ryu",
						engine: "ryu",
						transport: "acp",
						installed: true,
						lifecycle_status: "active",
					},
				],
			});
			return;
		}
		if (path === "/api/mcp/tools") {
			await fulfill({
				tools: [{ name: "web.search" }, { name: "terminal.execute" }],
			});
			return;
		}
		if (path === "/api/skills") {
			await fulfill({
				skills: [
					{ id: "checkpoint-skill", name: "Checkpoint skill", enabled: true },
					{ id: "current-skill", name: "Current skill", enabled: true },
				],
			});
			return;
		}
		if (path.includes("spaces")) {
			await fulfill({ spaces: [{ id: "saved-space", name: "Saved space" }] });
			return;
		}
		// Read-only background catalog responses; none authorizes a mutation.
		await fulfill({
			agents: [],
			engines: [],
			active: null,
			styles: [],
			tools: [],
			skills: [],
			subscriptions: [],
			connections: [],
			preferences: {},
			agent_edit_panels: [],
			backgrounds: [],
		});
	});
	return {
		calls,
		errors,
		unexpected,
		entitlementPreferences: () =>
			entitlementPreferences.snapshot("entitlement-active"),
		managedInferencePreferences: () =>
			entitlementPreferences.snapshot("managed-inference-entitled"),
		current: () => structuredClone(current),
		immutable: () => structuredClone(immutable),
		refuse: () => {
			refuse = true;
		},
		hold: () => {
			held = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release: () => {
			release();
			held = null;
		},
	};
}
async function boot(page: Page) {
	await page.goto("/agent-version-history-proof.html");
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Current agent",
	);
}
async function assertManagedEntitlementReadback(
	page: Page,
	fixture: Awaited<ReturnType<typeof install>>,
) {
	await expect
		.poll(() => fixture.managedInferencePreferences().a)
		.toBe("false");
	const readback = await page.evaluate(async () => {
		const response = await fetch(
			"/scope-a/api/preferences/managed-inference-entitled",
			{
				headers: {
					authorization: "Bearer version-bearer-a",
					"x-ryu-user-jwt": "version-user-a",
				},
			},
		);
		return { status: response.status, body: await response.json() };
	});
	expect(readback).toEqual({
		status: 200,
		body: { key: "managed-inference-entitled", value: "false" },
	});
	const writes = fixture.calls.filter(
		(call) =>
			call.scope === "a" &&
			call.path === "/api/preferences/managed-inference-entitled" &&
			call.method === "PUT",
	);
	expect(writes.length).toBeGreaterThan(0);
	for (const call of writes)
		expect(call).toMatchObject({
			authorization: "Bearer version-bearer-a",
			jwt: "version-user-a",
			body: { value: "false" },
		});
}

async function history(page: Page) {
	await page.getByRole("tab", { name: "Versions", exact: true }).click();
	await page.getByRole("button", { name: /^History/ }).click();
	await expect(
		page.getByText("Immutable checkpoint", { exact: true }),
	).toBeVisible();
}

test("actual AgentEditPage restores the complete checkpoint and a subsequent save round-trips restored capabilities", async ({
	page,
}) => {
	const fixture = await install(page);
	await boot(page);
	await history(page);
	await page.getByRole("button", { name: "Diff", exact: true }).click();
	await expect(
		page.locator("pre").filter({ hasText: "checkpoint-model" }).first(),
	).toBeVisible();
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		baseline.name,
	);
	await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
		baseline.description,
	);
	expect(fixture.calls.filter((c) => c.path === RESTORE)).toEqual([
		{
			scope: "a",
			path: RESTORE,
			method: "POST",
			body: null,
			authorization: "Bearer version-bearer-a",
			jwt: "version-user-a",
		},
	]);
	expect(fixture.current()).toEqual(baseline);
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		baseline.name,
	);
	await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
		baseline.description,
	);
	await page
		.getByLabel("Name", { exact: true })
		.fill("Restored checkpoint edited");
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter((c) => c.path === PATH && c.method === "PUT")
					.length,
		)
		.toBe(1);
	const saved = fixture.calls.find(
		(c) => c.path === PATH && c.method === "PUT",
	)?.body;
	expect(saved).toMatchObject({
		name: "Restored checkpoint edited",
		title: baseline.title,
		description: baseline.description,
		system_prompt: baseline.system_prompt,
		engine: baseline.engine,
		model: baseline.model,
		chat_model: baseline.chat_model,
		tools: baseline.tools,
		skills: baseline.skills,
		memory: baseline.memory,
		inference: baseline.inference,
		orchestrator: baseline.orchestrator,
		can_create_agents: baseline.can_create_agents,
		safety_profile: baseline.safety_profile,
		persona: {
			display_name: baseline.persona.display_name,
			tone: baseline.persona.tone,
		},
		version: "1.2.4",
	});
	expect(saved).not.toHaveProperty("token");
	expect(saved).not.toHaveProperty("userJwt");
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Restored checkpoint edited",
	);
	expect(fixture.current()).toMatchObject({
		name: "Restored checkpoint edited",
		tools: baseline.tools,
		skills: baseline.skills,
		memory: baseline.memory,
		persona: baseline.persona,
	});
	expect(fixture.immutable()).toEqual(baseline);
	expect(fixture.entitlementPreferences().a).toBe("true");
	await assertManagedEntitlementReadback(page, fixture);
	expect(fixture.unexpected).toEqual([]);
	expect(fixture.errors).toEqual([]);
});

test("a real HTTP503 restore keeps the actual unsaved editor draft and explicit identical retry reloads saved fields", async ({
	page,
}) => {
	const fixture = await install(page);
	await boot(page);
	await page
		.getByLabel("Name", { exact: true })
		.fill("Unsaved draft must survive refusal");
	fixture.refuse();
	await history(page);
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(
		page.getByText(`${RESTORE} failed: 503`, { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Unsaved draft must survive refusal",
	);
	expect(fixture.current()).toEqual(initial);
	expect(fixture.immutable()).toEqual(baseline);
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		baseline.name,
	);
	expect(fixture.calls.filter((c) => c.path === RESTORE)).toHaveLength(2);
	expect(fixture.calls.filter((c) => c.path === RESTORE)[0]).toEqual(
		fixture.calls.filter((c) => c.path === RESTORE)[1],
	);
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		baseline.name,
	);
	expect(fixture.entitlementPreferences().a).toBe("true");
	await assertManagedEntitlementReadback(page, fixture);
	expect(fixture.unexpected).toEqual([]);
	expect(fixture.errors).toEqual([]);
});

test("a late restore acknowledgement from node A cannot replace the actual node B editor", async ({
	page,
}) => {
	const fixture = await install(page);
	await boot(page);
	fixture.hold();
	await history(page);
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect
		.poll(() => fixture.calls.filter((c) => c.path === RESTORE).length)
		.toBe(1);
	await expect(
		page.getByRole("button", { name: "Restore", exact: true }),
	).toBeDisabled();
	try {
		await page
			.getByRole("button", { name: "Use scope B", exact: true })
			.click();
		await expect
			.poll(() =>
				fixture.calls.some(
					(c) => c.scope === "b" && c.path === PATH && c.method === "GET",
				),
			)
			.toBe(true);
		await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
			"Scope B agent",
		);
		// Changing authority resets the editor to Behavior; open the actual B history.
		await history(page);
		await expect(
			page.getByRole("button", { name: "Restore", exact: true }),
		).toBeEnabled();
		fixture.release();
		await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
			"Scope B agent",
		);
		await expect(
			page.getByRole("button", { name: "Restore", exact: true }),
		).toBeEnabled();
		await expect(
			page.getByText("Immutable checkpoint", { exact: true }),
		).toBeVisible();
		expect(
			fixture.calls.filter((c) => c.scope === "b" && c.path === RESTORE),
		).toEqual([]);
		expect(fixture.entitlementPreferences().a).toBe("true");
		await assertManagedEntitlementReadback(page, fixture);
		expect(fixture.unexpected).toEqual([]);
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.release();
	}
});

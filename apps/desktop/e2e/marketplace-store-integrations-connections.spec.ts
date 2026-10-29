import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	type IntegrationsProofJson,
	integrationsComposioConnectSchema,
	integrationsMcpConnectSchema,
	integrationsProofJsonSchema,
} from "./marketplace-store-integrations-proof.contracts.ts";

const proofDir = resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/marketplace-assets/store-integrations-connections"
);
const apiOrigin =
	process.env.RYU_STORE_TEST_API_ORIGIN ?? "http://127.0.0.1:5493";
const story = "/marketplace-store-catalogs.html";

async function fixture(page: Page, configured = true, mcp = false) {
	const calls: Array<{
		path: string;
		method: string;
		body: IntegrationsProofJson;
	}> = [];
	const external: string[] = [];
	const deleteQueries: string[] = [];
	let attempts = 0;
	let access = "read_only";
	let mcpConnected = false;
	let mcpAttempts = 0;
	let deleteAttempts = 0;
	await page.exposeFunction("recordStoreExternal", (url: string) =>
		external.push(url)
	);
	await page.addInitScript(() => {
		Object.assign(window, {
			__TAURI_INTERNALS__: {
				invoke: async (command: string, args: { url?: string }) => {
					if (command !== "open_external" || !args.url) {
						throw new Error(`Unexpected native command: ${command}`);
					}
					if (!window.recordStoreExternal) {
						throw new Error("Store external recorder is not installed");
					}
					await window.recordStoreExternal(args.url);
				},
			},
		});
	});
	await page.route(`${apiOrigin}/api/**`, async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const body = request.postData()
			? integrationsProofJsonSchema.parse(request.postDataJSON())
			: null;
		calls.push({ path, method: request.method(), body });
		let result: IntegrationsProofJson = {};
		let status = 200;
		if (path === "/api/composio/status") {
			result = { configured, base_url: "https://composio.example.test" };
		} else if (path === "/api/composio/toolkits") {
			result = {
				data: [
					{
						slug: "slack",
						name: "Slack",
						description: "Local Slack fixture",
						logo: null,
					},
				],
			};
		} else if (path === "/api/composio/connections") {
			result = {
				data: [
					{
						id: "fixture-connection",
						toolkit: "slack",
						active: true,
						status: "ACTIVE",
						access_level: access,
					},
				],
			};
		} else if (path === "/api/composio/connections/initiate") {
			attempts += 1;
			if (attempts === 1) {
				status = 403;
				result = { error: "Fixture connection policy denied" };
			} else {
				access = integrationsComposioConnectSchema.parse(body).access_level;
				result = {
					access_level: access,
					connection_id: "fixture-connection",
					redirect_url: "https://authorize.example.test/slack",
					status: "INITIATED",
				};
			}
		} else if (path === "/api/plugins") {
			result = {
				apps: mcp
					? [
							{
								// Core serializes `built_in`, `version`, and `windows_first`
								// on every listed app; Desktop's app contract requires them.
								built_in: false,
								id: "com.ryu.fixture",
								name: "Fixture account",
								version: "1.0.0",
								windows_first: false,
								enabled: true,
								installed: true,
								installed_version: "1.0.0",
								local_only: false,
								permission_grants: [],
								runnables: [],
								sidecar_name: null,
								mcp_servers: {
									remote: {
										url: "https://mcp.example.test",
										auth: { type: "oauth" },
									},
								},
							},
						]
					: [],
			};
		} else if (path === "/api/plugins/com.ryu.fixture/auth") {
			result = {
				servers: [
					{
						server_name: "remote",
						resource: "https://mcp.example.test",
						connections: mcpConnected
							? [
									{
										id: "mcp-connection",
										profile_id: "personal",
										access_level: access,
										status: "connected",
										issuer: "https://authorize.example.test",
										resource_uri: "https://mcp.example.test",
										scopes: ["tools:read"],
									},
								]
							: [],
					},
				],
			};
		} else if (path === "/api/plugins/com.ryu.fixture/auth/remote/connect") {
			mcpAttempts += 1;
			if (mcpAttempts === 1) {
				status = 403;
				result = { error: "Fixture MCP policy denied" };
			} else {
				access = integrationsMcpConnectSchema.parse(body).access_level;
				result = {
					access_level: access,
					authorization_url: "https://authorize.example.test/mcp",
					callback_mode: "loopback",
					expires_at: 1_900_000_000,
					flow_id: "fixture-flow",
					scopes: ["tools:read"],
					status: "pending",
				};
			}
		} else if (
			path === "/api/plugins/com.ryu.fixture/auth/flows/fixture-flow"
		) {
			mcpConnected = true;
			result = {
				access_level: access,
				callback_mode: "loopback",
				expires_at: 1_900_000_000,
				flow_id: "fixture-flow",
				plugin_id: "com.ryu.fixture",
				profile_id: "personal",
				server_name: "remote",
				scopes: ["tools:read"],
				status: "connected",
			};
		} else if (
			path === "/api/plugins/com.ryu.fixture/auth/remote" &&
			request.method() === "DELETE"
		) {
			deleteQueries.push(new URL(request.url()).search);
			deleteAttempts += 1;
			if (deleteAttempts === 1) {
				status = 403;
				result = { error: "Fixture logout denied" };
			} else {
				mcpConnected = false;
				result = { deleted: true, revocation: "confirmed" };
			}
		} else if (path === "/api/identities") {
			result = { profiles: [] };
		} else if (path === "/api/catalog/sources") {
			result = { active: "", sources: [] };
		} else if (path === "/api/models/catalog") {
			result = { models: [], next_cursor: null, total: 0 };
		} else if (path === "/api/skills/catalog") {
			result = { skills: [], next_cursor: null, total: 0 };
		} else if (path === "/api/mcp/catalog") {
			result = { servers: [], next_cursor: null, total: 0 };
		} else if (path === "/api/plugins/catalog") {
			result = { entries: [] };
		} else if (path === "/api/agents/catalog") {
			result = { agents: [] };
		}
		await route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(result),
		});
	});
	return { calls, external, deleteQueries };
}

test("Connections cancels without mutation, retries denied permission and reads back chosen access", async ({
	page,
}) => {
	const state = await fixture(page);
	await page.goto(`${story}?section=connections`);
	await expect(
		page.getByText("Access: Read only", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	const dialog = page.getByTestId("connection-permission-dialog");
	await expect(dialog.getByRole("radio", { name: /Read only/ })).toBeChecked();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(state.calls.filter((call) => call.method === "POST")).toEqual([]);
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await dialog.getByRole("radio", { name: /Write access/ }).check();
	await dialog
		.getByRole("button", { name: "Continue to connect", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Fixture connection policy denied"
	);
	expect(state.external).toEqual([]);
	expect(
		state.calls.filter((call) => call.path === "/api/composio/connections")
	).toHaveLength(1);
	await expect(
		dialog.getByRole("radio", { name: /Write access/ })
	).toBeChecked();
	await dialog
		.getByRole("button", { name: "Continue to connect", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Access: Write access", { exact: true })
	).toBeVisible();
	expect(state.calls.filter((call) => call.method === "POST")).toEqual([
		{
			path: "/api/composio/connections/initiate",
			method: "POST",
			body: { access_level: "write", toolkit: "slack" },
		},
		{
			path: "/api/composio/connections/initiate",
			method: "POST",
			body: { access_level: "write", toolkit: "slack" },
		},
	]);
	expect(state.external).toEqual(["https://authorize.example.test/slack"]);
	expect(
		state.calls.filter((call) => call.path === "/api/composio/connections")
			.length
	).toBeGreaterThanOrEqual(2);
	await page.reload();
	await expect(
		page.getByText("Access: Write access", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Connected", { exact: true })).toBeVisible();
	mkdirSync(proofDir, { recursive: true });
	await page.screenshot({
		path: resolve(proofDir, "connection-access-readback.png"),
	});
});

test("Connections without configured key suppresses account reads and opens Gateway keys", async ({
	page,
}) => {
	const state = await fixture(page, false);
	await page.goto(`${story}?section=connections`);
	await expect(
		page.getByText("Add your Composio key to connect accounts", { exact: true })
	).toBeVisible();
	expect(
		state.calls.filter((call) =>
			["/api/composio/toolkits", "/api/composio/connections"].includes(
				call.path
			)
		)
	).toEqual([]);
	await page
		.getByRole("button", { name: "Open Gateway keys", exact: true })
		.click();
	expect(state.calls.filter((call) => call.method === "POST")).toEqual([]);
	mkdirSync(proofDir, { recursive: true });
	await page.screenshot({
		path: resolve(proofDir, "connections-key-required.png"),
	});
});

test("App account reviews permission, retries denied start, polls readback and retries logout", async ({
	page,
}) => {
	const state = await fixture(page, false, true);
	await page.goto(`${story}?section=connections`);
	const card = page.getByRole("article").filter({ hasText: "Fixture account" });
	await expect(
		card.getByRole("button", { name: "Connect", exact: true })
	).toBeVisible();
	await card.getByRole("button", { name: "Connect", exact: true }).click();
	const dialog = page.getByTestId("connection-permission-dialog");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(state.calls.filter((call) => call.method === "POST")).toEqual([]);
	await card.getByRole("button", { name: "Connect", exact: true }).click();
	await dialog.getByRole("radio", { name: /Read only/ }).check();
	await dialog
		.getByRole("button", { name: "Continue to connect", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Fixture MCP policy denied"
	);
	expect(state.external).toEqual([]);
	await dialog
		.getByRole("button", { name: "Continue to connect", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	await expect(card.getByText("Connected", { exact: true })).toBeVisible();
	await expect(
		card.getByText("Access: Read only", { exact: true })
	).toBeVisible();
	await expect(
		card.getByText("Scopes: tools:read", { exact: true })
	).toBeVisible();
	expect(state.external).toEqual(["https://authorize.example.test/mcp"]);
	expect(state.calls.filter((call) => call.method === "POST")).toEqual(
		Array.from({ length: 2 }, () => ({
			path: "/api/plugins/com.ryu.fixture/auth/remote/connect",
			method: "POST",
			body: {
				access_level: "read_only",
				callback_mode: "auto",
				profile_id: "personal",
			},
		}))
	);
	await page.reload();
	await expect(card.getByText("Connected", { exact: true })).toBeVisible();
	await expect(
		card.getByText("Access: Read only", { exact: true })
	).toBeVisible();
	await page
		.getByRole("heading", { name: "Connections", exact: true })
		.scrollIntoViewIfNeeded();
	mkdirSync(proofDir, { recursive: true });
	await page.screenshot({
		path: resolve(proofDir, "mcp-account-connected-readback.png"),
	});
	await card.getByRole("button", { name: "Log out", exact: true }).click();
	await expect(
		page.getByText("Fixture logout denied", { exact: true })
	).toBeVisible();
	await expect(card.getByText("Connected", { exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Log out", exact: true }).click();
	await expect(
		card.getByRole("button", { name: "Connect", exact: true })
	).toBeVisible();
	await expect(card.getByText("Connected", { exact: true })).toHaveCount(0);
	expect(state.calls.filter((call) => call.method === "DELETE")).toEqual(
		Array.from({ length: 2 }, () => ({
			path: "/api/plugins/com.ryu.fixture/auth/remote",
			method: "DELETE",
			body: null,
		}))
	);
	expect(state.deleteQueries).toEqual([
		"?profile_id=personal",
		"?profile_id=personal",
	]);
	await page.reload();
	await expect(
		card.getByRole("button", { name: "Connect", exact: true })
	).toBeVisible();
	await expect(card.getByText("Connected", { exact: true })).toHaveCount(0);
	await page.screenshot({
		path: resolve(proofDir, "mcp-account-logout-readback.png"),
	});
});

// Playwright binds this exact host callback before the init script executes.
declare global {
	interface Window {
		recordStoreExternal?: (url: string) => Promise<number>;
	}
}

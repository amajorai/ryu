import path from "node:path";
import { expect, test } from "@playwright/test";

interface ProofCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface ProofState {
	calls: ProofCall[];
	hooks: {
		hooks: Array<{
			hookKey: string;
			localOverrides: Record<string, { enabled?: boolean; trusted?: boolean }>;
		}>;
	};
}

declare global {
	interface Window {
		__RYU_GATEWAY_HOOKS_MCP_PROOF__?: {
			readState: () => ProofState;
		};
	}
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceOverride = process.env.RYU_PROOF_EVIDENCE_DIR;
const evidence = (name: string) =>
	evidenceOverride
		? path.join(evidenceOverride, name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);

const state = (page: import("@playwright/test").Page) =>
	page.evaluate(() => {
		const proof = window.__RYU_GATEWAY_HOOKS_MCP_PROOF__;
		if (!proof) {
			throw new Error("Gateway hooks and MCP fixtures were not installed");
		}
		return proof.readState();
	});

const openFreshVariant = async (
	page: import("@playwright/test").Page,
	query: string
) => {
	await page.evaluate(() => localStorage.clear());
	await page.goto(`/gateway-hooks-mcp-proof.html?${query}`);
};

test.beforeEach(async ({ page }) => {
	await page.goto("/gateway-hooks-mcp-proof.html");
	await expect(
		page.getByRole("heading", { name: "Hooks and MCP", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Security Guidance", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Docs Remote", { exact: true }).first()
	).toBeVisible();
});

test("renders hook provenance, review metadata, and disabled-plugin boundaries", async ({
	page,
}) => {
	await expect(page.getByText("From config", { exact: true })).toBeVisible();
	await expect(page.getByText("From plugins", { exact: true })).toBeVisible();
	await expect(
		page.getByText("1 needs review", { exact: true }).first()
	).toBeVisible();
	await page.getByRole("button", { name: "Show details for review" }).click();
	await expect(
		page.getByText("Sandboxed JavaScript", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("hooks/review.js", { exact: true })
	).toBeVisible();
	await expect(page.getByText('{"flag":"io.example.review"}')).toBeVisible();
	const hookMetadata = page
		.locator("dl")
		.filter({ hasText: "Sandboxed JavaScript" });
	await expect(
		hookMetadata.getByText("Priority", { exact: true })
	).toBeVisible();
	await expect(hookMetadata.locator("dd").last()).toHaveText("review");
	await expect(
		page.getByText("Enable Disabled Plugin before this hook can run.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Trust cleanup" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Disable cleanup" })
	).toBeDisabled();
	await page.screenshot({
		path: evidence("gateway-hooks-mcp-inventory.png"),
		fullPage: true,
	});
});

test("writes node-scoped hook trust and enablement, then reloads the persisted policy", async ({
	page,
}) => {
	await expect(
		page.getByRole("tab", { name: "Effective", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText(
			"Resolved from user, team, organization, then node defaults."
		)
	).toBeVisible();
	await page.getByRole("tab", { name: "Node", exact: true }).click();
	await expect(
		page.getByRole("tab", { name: "Node", exact: true })
	).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Changes at this level override broader defaults.")
	).toBeVisible();
	const trust = page.getByRole("button", { name: "Trust review" });
	const switcher = page.getByRole("switch", { name: "Disable review" });
	await expect(switcher).toBeDisabled();
	await trust.click();
	await expect(
		page.getByRole("button", { name: "Remove trust from review" })
	).toBeVisible();
	await expect(switcher).toBeEnabled();
	await switcher.click();
	await expect(
		page.getByRole("switch", { name: "Enable review" })
	).not.toBeChecked();

	const beforeReload = await state(page);
	const writes = beforeReload.calls.filter(
		(call) => call.path === "/api/hooks/overrides"
	);
	expect(writes).toEqual([
		{
			body: {
				hookKey: "com.example.security::review",
				policy: { trusted: true },
				scope: "node",
			},
			method: "PUT",
			path: "/api/hooks/overrides",
			status: 200,
		},
		{
			body: {
				hookKey: "com.example.security::review",
				policy: { enabled: false, trusted: true },
				scope: "node",
			},
			method: "PUT",
			path: "/api/hooks/overrides",
			status: 200,
		},
	]);
	expect(
		beforeReload.hooks.hooks.find(
			(hook) => hook.hookKey === "com.example.security::review"
		)?.localOverrides.node
	).toEqual({ enabled: false, trusted: true });

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Remove trust from review" })
	).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Enable review" })
	).not.toBeChecked();
	await page.screenshot({
		path: evidence("gateway-hooks-node-policy-reloaded.png"),
		fullPage: true,
	});
});

test("keeps organization, team, and unauthorized node hook policies read-only", async ({
	page,
}) => {
	await page.goto("/gateway-hooks-mcp-proof.html?role=viewer");
	await expect(
		page.getByText("Security Guidance", { exact: true })
	).toBeVisible();
	for (const scope of ["Organization", "Team", "Node"]) {
		await page.getByRole("tab", { name: scope, exact: true }).click();
		await expect(
			page.getByRole("tab", { name: scope, exact: true })
		).toHaveAttribute("aria-selected", "true");
		await expect(
			page.getByRole("button", { name: "Trust review" })
		).toBeDisabled();
		await expect(
			page.getByRole("switch", { name: "Disable review" })
		).toBeDisabled();
	}
	const writes = (await state(page)).calls.filter(
		(call) => call.path === "/api/hooks/overrides"
	);
	expect(writes).toHaveLength(0);
});

test("retries a failed hook policy write without losing the requested change", async ({
	page,
}) => {
	await openFreshVariant(page, "hookWriteFailOnce=1");
	await expect(
		page.getByText("Security Guidance", { exact: true })
	).toBeVisible();
	await page.getByRole("tab", { name: "User", exact: true }).click();
	await page.getByRole("button", { name: "Trust review" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Hook policy could not be saved. Check the connection and retry."
	);
	await expect(
		page.getByRole("button", { name: "Trust review" })
	).toBeVisible();
	await page.getByRole("tab", { name: "Node", exact: true }).click();
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByRole("button", { name: "Remove trust from review" })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);

	const writes = (await state(page)).calls.filter(
		(call) => call.path === "/api/hooks/overrides"
	);
	expect(writes).toHaveLength(2);
	expect(writes[0]).toMatchObject({
		body: {
			hookKey: "com.example.security::review",
			policy: { trusted: true },
			scope: "user",
		},
		status: 503,
	});
	expect(writes[1]).toMatchObject({
		body: {
			hookKey: "com.example.security::review",
			policy: { trusted: true },
			scope: "user",
		},
		status: 200,
	});
	expect(writes[1]?.body).toEqual(writes[0]?.body);
	const savedHook = (await state(page)).hooks.hooks.find(
		(hook) => hook.hookKey === "com.example.security::review"
	);
	expect(savedHook?.localOverrides.user).toEqual({ trusted: true });
	expect(savedHook?.localOverrides.node).toBeUndefined();
	await page.reload();
	await page.getByRole("tab", { name: "User", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Remove trust from review" })
	).toBeVisible();
	await page.screenshot({
		path: evidence("gateway-hooks-user-retry-reloaded.png"),
		fullPage: true,
	});
});

test("recovers hook inventory through the visible refresh after Core load failure", async ({
	page,
}) => {
	await openFreshVariant(page, "hookLoadFailOnce=1");
	await expect(
		page.getByText("/api/hooks/management failed: 503")
	).toBeVisible();
	await expect(
		page.getByText("No hooks installed", { exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Refresh hooks" }).click();
	await expect(
		page.getByRole("button", { name: "Show details for review" })
	).toBeVisible();
	const loads = (await state(page)).calls.filter(
		(call) => call.path === "/api/hooks/management"
	);
	expect(loads.map((call) => call.status)).toEqual([503, 200]);
});

test("filters the MCP inventory across server names and fully-qualified tool ids", async ({
	page,
}) => {
	const servers = page.getByRole("heading", {
		name: "MCP servers",
		exact: true,
	});
	await expect(servers).toBeVisible();
	await expect(page.getByText("Desktop only", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Missing command", { exact: true })
	).toBeVisible();
	await expect(page.getByText("missing", { exact: true })).toBeVisible();
	const toolPanel = page.getByRole("heading", {
		name: "Available tools",
		exact: true,
	});
	await expect(toolPanel).toBeVisible();
	await expect(page.getByText("search", { exact: true })).toBeVisible();
	await expect(page.getByText("fetch", { exact: true })).toBeVisible();
	await expect(page.getByText("read", { exact: true })).toHaveCount(0);

	const search = page.getByRole("textbox", {
		name: "Search MCP servers and tools",
	});
	await search.fill("Docs Remote.search");
	await expect(
		page.getByText("No MCP servers registered. Add one from the Tools page.")
	).toBeVisible();
	await expect(page.getByText("search", { exact: true })).toBeVisible();
	await expect(page.getByText("fetch", { exact: true })).toHaveCount(0);

	await search.fill("Desktop only");
	await expect(page.getByText("Desktop only", { exact: true })).toBeVisible();
	await expect(
		page.getByText("No enabled servers advertise tools.")
	).toBeVisible();
	await expect(page.getByText("read", { exact: true })).toHaveCount(0);

	await search.fill("");
	await expect(page.getByText("fetch", { exact: true })).toBeVisible();
	await page.screenshot({
		path: evidence("gateway-mcp-search-and-enabled-tools.png"),
		fullPage: true,
	});
});

test("refreshes both MCP lists after the server inventory request fails", async ({
	page,
}) => {
	await openFreshVariant(page, "mcpLoadFailOnce=1");
	await expect(page.getByText("/api/mcp/servers failed: 503")).toHaveCount(2);
	await page.getByRole("button", { name: "Refresh MCP inventory" }).click();
	await expect(
		page.getByText("Docs Remote", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("search", { exact: true })).toBeVisible();
	const calls = (await state(page)).calls;
	expect(
		calls
			.filter((call) => call.path === "/api/mcp/servers")
			.map((call) => call.status)
	).toEqual([503, 200]);
	expect(
		calls
			.filter((call) => call.path === "/api/mcp/tools")
			.map((call) => call.status)
	).toEqual([200, 200]);
	await page.screenshot({
		path: evidence("gateway-mcp-retry-recovered.png"),
		fullPage: true,
	});
});

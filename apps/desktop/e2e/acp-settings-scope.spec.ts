import path from "node:path";
import { expect, type Route, test } from "@playwright/test";

// `fetchGatewayConfig` validates the whole served document, and a Gateway
// always serves `auth` and `providers`; a bare `{ acp }` body is rejected as an
// unreadable config (the same base `computer-use-settings-proof.tsx` serves).
const SERVED_CONFIG_BASE = {
	auth: { api_keys: [], require_auth: false },
	providers: {
		anthropic: null,
		core: null,
		genai: null,
		local: null,
		openai: null,
		openrouter: null,
	},
};

test("ACP settings share pending reads only within their credential scope", async ({
	page,
}) => {
	const requests: Route[] = [];
	let failures = 0;
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/gateway/config")) {
			failures += 1;
		}
	});
	await page.route("**/api/gateway/config", (route) => {
		requests.push(route);
	});
	await page.goto("/acp-settings-scope-proof.html");
	await expect.poll(() => requests.length).toBe(1);
	await page
		.getByRole("button", { name: "Open second settings view", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "ACP agent runtime", exact: true })
	).toHaveCount(2);
	expect(requests).toHaveLength(1);
	const config = (awake: boolean) => ({
		...SERVED_CONFIG_BASE,
		acp: {
			idle_timeout_minutes: 10,
			max_parallel_agents: null,
			keep_computer_awake: awake,
			active_agents: 1,
			effective_max_parallel_agents: 4,
		},
	});
	await requests[0].fulfill({ json: config(true) });
	const switches = page.getByRole("switch", {
		name: "Keep this device awake while agents run",
	});
	await expect(switches).toHaveCount(2);
	await expect(switches.nth(0)).toBeChecked();
	await expect(switches.nth(1)).toBeChecked();
	await page
		.getByRole("button", { name: "Rotate node token", exact: true })
		.click();
	await expect.poll(() => requests.length).toBe(2);
	expect(requests[1].request().headers().authorization).toBe(
		"Bearer second-fixture"
	);
	await expect(switches).toHaveCount(0);
	await requests[1].fulfill({ json: config(false) });
	await expect(switches).toHaveCount(2);
	await expect(switches.nth(0)).not.toBeChecked();
	await expect(switches.nth(1)).not.toBeChecked();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep/acp-settings-scope-completed.png"
		),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Rotate user identity", exact: true })
		.click();
	await expect.poll(() => requests.length).toBe(3);
	await page
		.getByRole("button", { name: "Close both settings views", exact: true })
		.click();
	await expect.poll(() => failures).toBe(1);
	await expect(
		page.getByText("Settings views closed", { exact: true })
	).toBeVisible();
	expect(requests).toHaveLength(3);
});

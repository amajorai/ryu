import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { PluginValue } from "../src/lib/api/plugin-wire-values.ts";
import {
	coreProofRosterSchema,
	coreProofStateSchema,
} from "./core-live-proof.contracts.ts";

test("agent picker renders a live populated Core roster", async ({
	page,
	request,
}) => {
	const statePath = process.env.RYU_PERF_CORE_STATE;
	if (!statePath) {
		throw new Error(
			"Set RYU_PERF_CORE_STATE to an isolated populated Core state file."
		);
	}
	const state = coreProofStateSchema.parse(
		JSON.parse(await readFile(statePath, "utf8"))
	);
	const token = await readFile(
		path.join(state.dataDir, ".performance-token"),
		"utf8"
	);
	let agentReads = 0;
	let agents = 0;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (url.pathname === "/api/agents") {
			agentReads += 1;
			const response = await request.get(
				`http://127.0.0.1:${state.port}/api/agents`,
				{ headers: { authorization: `Bearer ${token}` } }
			);
			expect(response.status()).toBe(200);
			agents = coreProofRosterSchema.parse(await response.json()).agents.length;
			await route.fulfill({ response });
			await response.dispose();
			return;
		}
		const payloads = new Map<string, PluginValue>(
			Object.entries<PluginValue>({
				"/api/mcp/servers": {
					servers: [
						{
							name: "Workspace",
							command: "fixture",
							enabled: true,
							available: true,
							transport: "stdio",
						},
					],
				},
				"/api/mcp/tools": { tools: [] },
				"/api/apps": { apps: [] },
				"/api/identities": { profiles: [] },
			})
		);
		await route.fulfill({ json: payloads.get(url.pathname) ?? {} });
	});
	await page.goto("/mcp-performance-proof.html");
	await expect.poll(() => agents).toBeGreaterThanOrEqual(250);
	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	const opened = performance.now();
	await page.getByRole("combobox", { name: "Allowlist", exact: true }).click();
	await expect(
		page.getByRole("option", { name: "Performance fixture 0000", exact: true })
	).toBeVisible();
	const allowlistOpenWallMs =
		Math.round((performance.now() - opened) * 100) / 100;
	const last = page.getByRole("option", {
		name: "Performance fixture 0249",
		exact: true,
	});
	await last.scrollIntoViewIfNeeded();
	await expect(last).toBeVisible();
	await last.click();
	await expect(
		page.getByRole("combobox", { name: "Allowlist", exact: true })
	).toContainText("Performance fixture 0249");
	expect(agentReads).toBe(1);
	expect(errors).toEqual([]);
	const directory = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await page.screenshot({
		path: path.join(directory, "populated-agent-picker-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	await writeFile(
		path.join(directory, "populated-agent-picker.json"),
		`${JSON.stringify(
			{
				scope:
					"Actual Tools Library picker with live isolated Core agents; other MCP responses controlled",
				agents,
				agentReads,
				allowlistOpenWallMs,
			},
			null,
			2
		)}\n`
	);
});

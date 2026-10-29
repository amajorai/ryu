import path from "node:path";
import { expect, test } from "@playwright/test";

declare global {
	interface Window {
		keepAwakeCommands: boolean[];
	}
}

test("keep-awake reads are serialized, scoped and native recovery checks are preserved", async ({
	page,
}) => {
	const reads: string[] = [];
	const failures: string[] = [];
	await page.addInitScript(() => {
		window.keepAwakeCommands = [];
		Reflect.set(window, "__TAURI_INTERNALS__", {
			transformCallback: () => 0,
			invoke: (command: string, args: { enabled: boolean }) => {
				if (command === "set_keep_awake") {
					window.keepAwakeCommands.push(args.enabled);
				}
				return Promise.resolve();
			},
		});
	});
	const config = {
		acp: {
			idle_timeout_minutes: 10,
			max_parallel_agents: null,
			keep_computer_awake: true,
			active_agents: 1,
			effective_max_parallel_agents: 4,
		},
	};
	let hold = false;
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/gateway/config")) {
			failures.push(request.url());
		}
	});
	await page.route("**/api/gateway/config", async (route) => {
		const url = new URL(route.request().url());
		if (url.port !== "5236") {
			reads.push(route.request().headers().authorization ?? "");
			if (hold) {
				return;
			}
		}
		await route.fulfill({ json: config });
	});
	await page.goto("/keep-awake-proof.html");
	const commands = () => page.evaluate(() => window.keepAwakeCommands);
	await expect.poll(commands).toEqual([true]);
	expect(reads).toHaveLength(1);
	await page.getByRole("button", { name: "Rename node", exact: true }).click();
	expect(reads).toHaveLength(1);
	await expect.poll(() => reads.length, { timeout: 15_000 }).toBe(2);
	expect(await commands()).toEqual([true, true]);
	hold = true;
	await page.getByRole("button", { name: "Rotate token", exact: true }).click();
	await expect.poll(() => reads.length).toBe(3);
	expect(reads[2]).toBe("Bearer rotated-fixture");
	await expect.poll(() => failures.length, { timeout: 15_000 }).toBe(1);
	expect(reads).toHaveLength(3);
	await expect.poll(commands).toEqual([true, true, false]);
	await page.getByRole("button", { name: "Remote node", exact: true }).click();
	await expect.poll(commands).toEqual([true, true, false, false]);
	expect(reads).toHaveLength(3);
	await page
		.getByRole("button", { name: "Unmount monitor", exact: true })
		.click();
	await expect(
		page.getByRole("switch", {
			name: "Keep this device awake while agents run",
		})
	).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Maximum parallel ACP agents" })
	).toContainText(/auto/i);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep/keep-awake-completed.png"
		),
		fullPage: true,
		animations: "disabled",
	});
});

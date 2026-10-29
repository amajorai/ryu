import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { coreProofStateSchema } from "./core-live-proof.contracts.ts";

test("installed apps render from live isolated Core lists and contributions", async ({
	page,
	request,
}) => {
	const statePath = process.env.RYU_PERF_CORE_STATE;
	if (!statePath) {
		throw new Error("Set RYU_PERF_CORE_STATE to the isolated Core state file.");
	}
	const state = coreProofStateSchema.parse(
		JSON.parse(await readFile(statePath, "utf8"))
	);
	const token = await readFile(
		path.join(state.dataDir, ".performance-token"),
		"utf8"
	);
	const calls: { path: string; status: number; ms: number }[] = [];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (route.request().method() !== "GET") {
			throw new Error("Live proof only permits reads.");
		}
		const start = performance.now();
		const response = await request
			.get(`http://127.0.0.1:${state.port}${url.pathname}${url.search}`, {
				headers: { authorization: `Bearer ${token}` },
				timeout: 15_000,
			})
			.catch(() => {
				throw new Error(`Live Core read failed: ${url.pathname}`);
			});
		calls.push({
			path: url.pathname,
			status: response.status(),
			ms: Math.round((performance.now() - start) * 100) / 100,
		});
		await route.fulfill({ response });
		await response.dispose();
	});
	await page.goto("/core-live-performance-proof.html");
	await expect
		.poll(() =>
			calls.some(
				(call) =>
					["/api/apps", "/api/plugins"].includes(call.path) &&
					call.status === 200
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			calls.some(
				(call) =>
					call.path === "/api/plugins/contributions" && call.status === 200
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Chat Broadcast", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Chat Broadcast", exact: true })
		.click();
	await expect
		.poll(
			() =>
				calls.some(
					(call) =>
						call.path === "/api/plugins/catalog/detail" && call.status === 200
				),
			{ timeout: 20_000 }
		)
		.toBe(true);
	await expect(
		page.getByRole("dialog", { name: "Chat Broadcast", exact: true })
	).toBeVisible();
	await page.getByRole("tab", { name: "Dependencies", exact: true }).click();
	expect(errors).toEqual([]);
	const folder = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await mkdir(folder, { recursive: true });
	await page.screenshot({
		path: path.join(folder, "core-live-apps-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	await writeFile(
		path.join(folder, "core-live-browser.json"),
		`${JSON.stringify(
			{
				scope:
					"Actual InstalledSection UI with GET requests forwarded to isolated live Core; no fixture payloads",
				calls,
			},
			null,
			2
		)}\n`
	);
	await page.unrouteAll({ behavior: "wait" });
});

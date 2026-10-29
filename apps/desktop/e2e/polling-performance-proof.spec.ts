import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { PluginValue } from "../src/lib/api/plugin-wire-values.ts";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/performance-sweep"
);
test("polls avoid overlap, pause when hidden and discard stale context", async ({
	page,
}) => {
	const calls: Record<string, number> = {};
	const releases: Array<() => void> = [];
	const errors: string[] = [];
	let held = false;
	let cancelled = 0;
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/")) {
			cancelled++;
		}
	});
	await page.clock.install();
	await page.route("**/*", async (route) => {
		const key = new URL(route.request().url()).pathname;
		if (!(key.startsWith("/proof/") || key.startsWith("/api/"))) {
			return route.continue();
		}
		calls[key] = (calls[key] ?? 0) + 1;
		if (held) {
			await new Promise<void>((resolve) => releases.push(resolve));
		}
		const bodies = new Map<string, PluginValue>(
			Object.entries<PluginValue>({
				"/api/inbox/unread-count": { counts: { all: 7 } },
				"/api/control-plane/nodes/sandboxes": {
					nodes: [
						{
							id: "edge",
							name: "Edge server",
							reachableUrl: "https://node.example.com",
							status: "online",
							hasGpu: false,
							sandboxes: [],
						},
					],
				},
				"/proof/health": { available: true },
				"/proof/sidecars": {
					available: true,
					sidecars: [{ name: "shadow", running: true }],
				},
				"/proof/control": { available: true, control: { paused: false } },
				"/proof/context": {
					available: true,
					context: { app_name: "Editor", capture_active: true, paused: false },
				},
			})
		);
		await route.fulfill({ json: bodies.get(key) ?? {} }).catch(() => undefined);
	});
	await page.goto("/polling-performance-proof.html");
	await expect(page.getByText("Edge server", { exact: true })).toBeVisible();
	await expect(page.getByTitle("Editor", { exact: true })).toBeVisible();
	await expect(page.getByTestId("inbox-nav-link")).toHaveAttribute(
		"aria-label",
		"Inbox, 7 unread"
	);
	held = true;
	await page.clock.fastForward(61_000);
	await expect.poll(() => releases.length).toBeGreaterThanOrEqual(5);
	const pendingCounts = { ...calls };
	await page.clock.fastForward(61_000);
	expect(calls).toEqual(pendingCounts);
	await page
		.getByRole("button", { name: "Refresh inbox", exact: true })
		.click();
	await expect.poll(() => cancelled).toBeGreaterThan(0);
	held = false;
	for (const release of releases.splice(0)) {
		release();
	}
	await expect.poll(() => calls["/proof/control"]).toBeGreaterThan(1);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", {
			configurable: true,
			value: true,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	const hiddenCounts = { ...calls };
	await page.clock.fastForward(120_000);
	expect(calls).toEqual(hiddenCounts);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", {
			configurable: true,
			value: false,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect
		.poll(() => calls["/api/control-plane/nodes/sandboxes"])
		.toBeGreaterThan(hiddenCounts["/api/control-plane/nodes/sandboxes"]);
	held = true;
	await page.clock.fastForward(7000);
	await expect.poll(() => releases.length).toBeGreaterThan(0);
	await page
		.getByRole("button", { name: "Pause context", exact: true })
		.click();
	await expect(
		page.getByTitle("context unavailable", { exact: true })
	).toBeVisible();
	held = false;
	for (const release of releases.splice(0)) {
		release();
	}
	await page.clock.fastForward(1000);
	await expect(page.getByTitle("Editor", { exact: true })).toHaveCount(0);
	await page
		.getByRole("button", { name: "Resume context", exact: true })
		.click();
	await expect(page.getByTitle("Editor", { exact: true })).toBeVisible();
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "web-island-completed.png"),
		animations: "disabled",
		fullPage: true,
	});
	held = true;
	await page.clock.fastForward(61_000);
	await expect.poll(() => releases.length).toBeGreaterThan(0);
	const beforeClose = cancelled;
	await page.getByRole("button", { name: "Close views", exact: true }).click();
	await expect.poll(() => cancelled).toBeGreaterThan(beforeClose);
	held = false;
	for (const release of releases.splice(0)) {
		release();
	}
	await page.clock.fastForward(120_000);
	expect(errors).toEqual([]);
	await writeFile(
		path.join(proofDir, "web-island-polling.json"),
		`${JSON.stringify(
			{
				pendingPollsDoNotOverlap: true,
				hiddenPolls: 0,
				staleContextDiscarded: true,
				cancelledWebRequests: cancelled,
				scope:
					"Actual Web components and Island hooks/views with controlled HTTP and IPC",
			},
			null,
			2
		)}\n`
	);
});

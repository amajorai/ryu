import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("automatic scans stay single-flight and dialog selections survive parent repaint", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let profileReads = 0;
	let listings = 0;
	let imports = 0;
	let releaseProfiles: () => void = () => undefined;
	const heldProfiles = new Promise<void>((resolve) => {
		releaseProfiles = resolve;
	});
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = route.request().url();
			if (url.includes("agent-sync/profiles")) {
				profileReads += 1;
				await heldProfiles;
				await route.fulfill({ json: { profiles: [] } });
				return;
			}
			if (url.includes("/threads/import")) {
				imports += 1;
				await route.fulfill({
					json: {
						conversation_id: "imported",
						already_imported: false,
						message_count: 24,
					},
				});
				return;
			}
			if (url.includes("/threads")) {
				listings += 1;
				await route.fulfill({
					json: {
						engine: "codex",
						supported: true,
						threads: [
							{
								id: "thread-1",
								engine: "codex",
								title: "Review workspace performance",
								cwd: "/workspace/project",
								message_count: 24,
								updated_at: Date.now(),
							},
						],
					},
				});
				return;
			}
			await route.fulfill({ json: {} });
		}
	);
	await page.clock.install();
	await page.goto("/thread-import-performance-proof.html");
	await expect(
		page.getByRole("heading", { name: "Agent conversations" })
	).toBeVisible();
	await page.clock.fastForward(4001);
	await expect.poll(() => profileReads).toBe(1);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await page.clock.fastForward(31_000);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	expect(profileReads).toBe(1);
	releaseProfiles();
	await expect(page.getByText("1 automatic imports completed")).toBeVisible();
	expect(imports).toBe(1);
	expect(listings).toBe(1);
	await page
		.getByRole("button", { name: "Import a thread", exact: true })
		.click();
	const row = page.getByRole("button", {
		name: /Review workspace performance/,
	});
	await row.click();
	await expect(row).toHaveAttribute("aria-pressed", "true");
	const beforeRepaint = listings;
	await page.evaluate(() => window.dispatchEvent(new Event("proof-repaint")));
	await expect(page.getByTestId("refresh")).toHaveText("1");
	await expect(row).toHaveAttribute("aria-pressed", "true");
	expect(listings).toBe(beforeRepaint);
	const screenshotPath = testInfo.outputPath("thread-import-completed.png");
	await page.screenshot({
		path: screenshotPath,
		fullPage: true,
	});
	const proofPath = proofEvidencePath(
		"thread-import-performance/thread-import-completed.png"
	);
	await mkdir(dirname(proofPath), { recursive: true });
	await copyFile(screenshotPath, proofPath);
	await page.evaluate(() => window.dispatchEvent(new Event("proof-identity")));
	await expect.poll(() => listings).toBe(beforeRepaint + 1);
	await expect(row).toHaveAttribute("aria-pressed", "false");
	await row.click();
	await page.getByRole("button", { name: "Import 1", exact: true }).click();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	expect(imports).toBe(2);
	expect(errors).toEqual([]);
	await testInfo.attach("request-counts", {
		body: JSON.stringify({ profileReads, listings, imports }),
		contentType: "application/json",
	});
});

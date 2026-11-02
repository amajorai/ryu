// Continues cowork-side-chats-proof.spec.ts (split under the file token limit); helpers live in cowork-side-chats-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	ensureEnvironmentOpen,
	entry,
} from "./cowork-side-chats-proof.helpers.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test.describe.configure({ timeout: 90_000 });

test("real pinned Environment retries denied pull, syncs, and cancels dialogs without mutations", async ({
	page,
}) => {
	const mutations: {
		path: string;
		body: unknown;
		token: string | undefined;
	}[] = [];
	let pullAttempts = 0;
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const headers = {
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "*",
			"access-control-allow-methods": "*",
		};
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}
		if (request.method() === "POST") {
			mutations.push({
				path,
				body: request.postDataJSON(),
				token: request.headers().authorization,
			});
			if (path === "/api/git/pull") {
				pullAttempts += 1;
			}
			await route.fulfill({
				headers,
				status: path === "/api/git/pull" && pullAttempts === 1 ? 403 : 200,
				json:
					path === "/api/git/pull" && pullAttempts === 1
						? { success: false, error: "Fixture pull denied" }
						: { success: true },
			});
			return;
		}
		await route.fulfill({
			headers,
			json:
				path === "/api/git/status"
					? {
							is_repo: true,
							branch: "fixture/feature",
							ahead: 0,
							behind: 0,
							dirty: true,
							changed_files_count: 2,
							insertions: 7,
							deletions: 3,
						}
					: path === "/api/git/branches"
						? {
								branches: ["fixture/feature", "main"],
								current: "fixture/feature",
								is_repo: true,
							}
						: path.endsWith("/btw")
							? []
							: path.includes("background")
								? { processes: [] }
								: {},
		});
	});
	await page.goto("/cowork-side-chats-proof.html?project=1");
	await ensureEnvironmentOpen(page);
	await page.getByRole("button", { name: "Pull latest changes" }).click();
	await expect(page.getByText("Fixture pull denied")).toBeVisible();
	await page.getByRole("button", { name: "Pull latest changes" }).click();
	await expect(page.getByText("Pulled latest changes")).toBeVisible();
	await page.getByRole("button", { name: "Sync with remote" }).click();
	await expect(page.getByText("Synced with remote")).toBeVisible();
	await page
		.getByRole("button", { name: "Commit or push", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await page
		.getByRole("button", { name: "Create pull request", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	expect(mutations).toEqual(
		["/api/git/pull", "/api/git/pull", "/api/git/sync"].map((path) => ({
			path,
			body: { cwd: "/fixture/pinned-project" },
			token: "Bearer fixture-node-token",
		}))
	);
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofEvidencePath(
			"test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/pinned-environment-sync-complete.png"
		),
		fullPage: true,
	});
});

test("side chat identity switch ignores a late old-account read", async ({
	page,
}) => {
	let releaseOldRead: (() => void) | undefined;
	let oldReadStarted = false;
	const reads: (string | undefined)[] = [];
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const request = route.request();
		const headers = {
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "*",
			"access-control-allow-methods": "*",
		};
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/btw")) {
			const token = request.headers().authorization;
			reads.push(token);
			if (token === "Bearer fixture-node-token") {
				oldReadStarted = true;
				await new Promise<void>((resolve) => {
					releaseOldRead = resolve;
				});
				await route.fulfill({ headers, json: [entry] }).catch(() => {});
			} else {
				await route.fulfill({
					headers,
					json: [
						{
							...entry,
							id: "new-aside",
							question: "New identity saved answer",
						},
					],
				});
			}
			return;
		}
		await route.fulfill({
			headers,
			json: path.includes("background") ? { processes: [] } : {},
		});
	});
	await page.goto("/cowork-side-chats-proof.html");
	await expect.poll(() => oldReadStarted).toBe(true);
	await page.getByRole("button", { name: "Change fixture identity" }).click();
	await page.getByRole("button", { name: /^Side chats/ }).click();
	await expect(
		page.getByRole("button", { name: /New identity saved answer/ })
	).toBeVisible();
	releaseOldRead?.();
	await expect(
		page.getByRole("button", { name: /Why retain the saved answer/ })
	).not.toBeVisible();
	expect(reads).toEqual([
		"Bearer fixture-node-token",
		"Bearer fixture-new-token",
	]);
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofEvidencePath(
			"test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/side-chat-identity-readback.png"
		),
		fullPage: true,
	});
});

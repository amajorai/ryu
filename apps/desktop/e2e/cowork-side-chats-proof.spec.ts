import { expect, test } from "@playwright/test";
import type { BtwEntry } from "../src/lib/api/btw.ts";

test.describe.configure({ timeout: 90_000 });
async function ensureEnvironmentOpen(page: import("@playwright/test").Page) {
	const section = page.getByRole("button", {
		name: "Environment",
		exact: true,
	});
	await expect(section).toBeVisible();
	if ((await section.getAttribute("aria-expanded")) !== "true") {
		await section.click();
	}
	await expect(section).toHaveAttribute("aria-expanded", "true");
}
/** Clicks the row's delete button and confirms the destructive dialog. */
async function deleteSideChat(page: import("@playwright/test").Page) {
	await page.getByRole("button", { name: "Delete side chat" }).click();
	const confirm = page.getByRole("alertdialog", {
		name: "Delete this side chat?",
	});
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Delete side chat" }).click();
	await expect(confirm).toBeHidden();
}

const entry: BtwEntry = {
	id: "aside/fixture",
	conversation_id: "conversation/fixture",
	question: "Why retain the saved answer?",
	answer: "It remains available until Core confirms deletion.",
	created_at: 1_790_000_000_000,
	model: "fixture-model",
};

test("a late refresh cannot restore a successfully deleted side chat", async ({
	page,
}) => {
	let saved = [entry];
	let reads = 0;
	let releaseRead: (() => void) | undefined;
	let delayedReadStarted = false;
	const headers = {
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "*",
		"access-control-allow-methods": "*",
	};
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const request = route.request();
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}
		const path = new URL(request.url()).pathname;
		if (request.method() === "DELETE" && path.startsWith("/api/btw/")) {
			expect(request.headers().authorization).toBe("Bearer fixture-node-token");
			expect(path).toBe("/api/btw/aside%2Ffixture");
			saved = [];
			await route.fulfill({ status: 204, headers });
			return;
		}
		if (path.endsWith("/btw")) {
			reads += 1;
			const response = saved;
			if (reads === 2) {
				delayedReadStarted = true;
				await new Promise<void>((resolve) => {
					releaseRead = resolve;
				});
			}
			await route.fulfill({ json: response, headers });
			return;
		}
		await route.fulfill({
			json: path.includes("background") ? { processes: [] } : {},
			headers,
		});
	});
	await page.goto("/cowork-side-chats-proof.html");
	const section = page.getByRole("button", { name: /^Side chats/ });
	await expect(section).toBeVisible();
	await section.click();
	await page
		.getByRole("button", { name: "Refresh fixture side chats" })
		.click();
	await expect.poll(() => delayedReadStarted).toBe(true);
	await deleteSideChat(page);
	await expect(section).not.toBeVisible();
	const lateResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith("/btw") && response.request().method() === "GET"
	);
	releaseRead?.();
	await (await lateResponse).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect(section).not.toBeVisible();
	expect(saved).toEqual([]);
	await page.reload();
	await expect.poll(() => reads).toBe(3);
	await expect(
		page.getByRole("button", { name: /^Environment/ })
	).toBeVisible();
	await expect(section).not.toBeVisible();
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/side-chat-late-refresh-deleted.png",
		fullPage: true,
	});
});

test("side chats preserve denied deletes, retry, and read back persisted removal", async ({
	page,
}) => {
	let saved = [entry];
	let deleteAttempts = 0;
	const requests: {
		path: string;
		method: string;
		authorization: string | undefined;
		body: string | null;
	}[] = [];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "OPTIONS") {
			await route.fulfill({
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-headers": "*",
					"access-control-allow-methods": "*",
				},
			});
			return;
		}
		if (path.endsWith("/btw") || path.startsWith("/api/btw/")) {
			requests.push({
				path,
				method: request.method(),
				authorization: request.headers().authorization,
				body: request.postData(),
			});
			if (request.method() === "DELETE") {
				deleteAttempts += 1;
				if (deleteAttempts === 1) {
					await route.fulfill({
						status: 403,
						json: { error: "Permission denied" },
					});
					return;
				}
				saved = [];
				await route.fulfill({ status: 204 });
				return;
			}
			await route.fulfill({ json: saved });
			return;
		}
		if (path === "/api/background/processes") {
			await route.fulfill({ json: { processes: [] } });
			return;
		}
		if (path.includes("diff")) {
			await route.fulfill({ json: { files: [], has_changes: false } });
			return;
		}
		await route.fulfill({ json: {} });
	});
	await page.goto("/cowork-side-chats-proof.html");
	const section = page.getByRole("button", { name: /^Side chats/ });
	await expect(section).toBeVisible();
	await section.click();
	const question = page.getByRole("button", {
		name: /Why retain the saved answer/,
	});
	await question.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-side-chats-proof.tsx installs __openedSideChat before this proof page is evaluated. */ (
						window as Window & { __openedSideChat?: BtwEntry }
					).__openedSideChat
			)
		)
		.toEqual(entry);
	await deleteSideChat(page);
	await expect(page.getByRole("alert")).toHaveText(
		"Could not delete side chat. Try again."
	);
	await expect(question).toBeVisible();
	expect(saved).toEqual([entry]);
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/side-chat-delete-retry.png",
		fullPage: true,
	});
	await deleteSideChat(page);
	await expect(section).not.toBeVisible();
	await page.reload();
	await expect(page.getByRole("button", { name: "Environment" })).toBeVisible();
	await expect
		.poll(() => requests.filter((request) => request.method === "GET").length)
		.toBe(2);
	await expect(section).not.toBeVisible();
	expect(requests).toEqual([
		{
			path: "/api/conversations/conversation%2Ffixture/btw",
			method: "GET",
			authorization: "Bearer fixture-node-token",
			body: null,
		},
		{
			path: "/api/btw/aside%2Ffixture",
			method: "DELETE",
			authorization: "Bearer fixture-node-token",
			body: null,
		},
		{
			path: "/api/btw/aside%2Ffixture",
			method: "DELETE",
			authorization: "Bearer fixture-node-token",
			body: null,
		},
		{
			path: "/api/conversations/conversation%2Ffixture/btw",
			method: "GET",
			authorization: "Bearer fixture-node-token",
			body: null,
		},
	]);
	await page.waitForTimeout(700);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/side-chat-delete-completed.png",
		fullPage: true,
	});
	expect(errors).toEqual([]);
});

test("refresh keeps a delete pending and identity changes ignore its late failure", async ({
	page,
}) => {
	let releaseDelete: (() => void) | undefined;
	let deleteCount = 0;
	let listCount = 0;
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
		if (request.method() === "DELETE") {
			deleteCount += 1;
			await new Promise<void>((resolve) => {
				releaseDelete = resolve;
			});
			await route.fulfill({
				status: 403,
				headers,
				json: { error: "Denied old identity" },
			});
			return;
		}
		if (path.endsWith("/btw")) {
			listCount += 1;
			await route.fulfill({ headers, json: [entry] });
			return;
		}
		await route.fulfill({
			headers,
			json: path.includes("background") ? { processes: [] } : {},
		});
	});
	await page.goto("/cowork-side-chats-proof.html");
	await page.getByRole("button", { name: /^Side chats/ }).click();
	const remove = page.getByRole("button", { name: "Delete side chat" });
	await remove.click();
	const confirm = page.getByRole("alertdialog", {
		name: "Delete this side chat?",
	});
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toBeHidden();
	expect(deleteCount).toBe(0);
	await deleteSideChat(page);
	await expect(remove).toBeDisabled();
	await page
		.getByRole("button", { name: "Refresh fixture side chats" })
		.click();
	await expect.poll(() => listCount).toBe(2);
	await expect(remove).toBeDisabled();
	expect(deleteCount).toBe(1);
	await page.getByRole("button", { name: "Change fixture identity" }).click();
	await expect.poll(() => listCount).toBe(3);
	await expect(remove).toBeEnabled();
	releaseDelete?.();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /Why retain the saved answer/ })
	).toBeVisible();
});

test("real pinned Environment commit caller preserves failure then retries and reads persisted status", async ({
	page,
}) => {
	let committed = false;
	let attempts = 0;
	const mutations: {
		path: string;
		body: unknown;
		token: string | undefined;
	}[] = [];
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const headers = {
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "*",
			"access-control-allow-methods": "*",
		};
		const fulfill = <Payload>(json: Payload, status = 200) =>
			route.fulfill({ json, headers, status });
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers });
			return;
		}
		if (url.pathname === "/api/git/status") {
			await fulfill({
				is_repo: true,
				branch: "fixture/feature",
				ahead: committed ? 1 : 0,
				behind: 0,
				dirty: !committed,
				changed_files_count: committed ? 0 : 2,
				insertions: committed ? 0 : 7,
				deletions: committed ? 0 : 3,
			});
			return;
		}
		if (url.pathname === "/api/git/commit-push") {
			mutations.push({
				path: url.pathname,
				body: request.postDataJSON(),
				token: request.headers().authorization,
			});
			attempts += 1;
			if (attempts === 1) {
				await fulfill(
					{ success: false, error: "Fixture permission denied" },
					403
				);
				return;
			}
			committed = true;
			await fulfill({ success: true, committed: true, commit: "fixture-head" });
			return;
		}
		if (url.pathname.endsWith("/btw")) {
			await fulfill([]);
			return;
		}
		if (url.pathname === "/api/background/processes") {
			await fulfill({ processes: [] });
			return;
		}
		if (url.pathname.includes("worktree")) {
			await fulfill({ active: false, files: [], has_changes: false });
			return;
		}
		if (url.pathname === "/api/git/branches") {
			await fulfill({
				branches: ["fixture/feature", "main"],
				current: "fixture/feature",
				is_repo: true,
			});
			return;
		}
		await fulfill({});
	});
	await page.goto("/cowork-side-chats-proof.html?project=1");
	await ensureEnvironmentOpen(page);
	await page
		.getByRole("button", { name: "Commit or push", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog
		.getByPlaceholder(/commit message/i)
		.fill("Keep reviewed changes");
	await dialog.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(dialog.getByText("Fixture permission denied")).toBeVisible();
	await expect(dialog.getByPlaceholder(/commit message/i)).toHaveValue(
		"Keep reviewed changes"
	);
	expect(committed).toBe(false);
	await dialog.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText("Committed fixture-head")).toBeVisible();
	expect(mutations).toEqual(
		[1, 2].map(() => ({
			path: "/api/git/commit-push",
			body: {
				cwd: "/fixture/pinned-project",
				message: "Keep reviewed changes",
				action: "commit",
				include_unstaged: true,
			},
			token: "Bearer fixture-node-token",
		}))
	);
	await page.reload();
	await ensureEnvironmentOpen(page);
	await expect(
		page.getByRole("button", { name: "Commit or push", exact: true })
	).toBeEnabled();
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/pinned-environment-readback.png",
		fullPage: true,
	});
});

test("side chat loading denial is visible and retry restores saved answers", async ({
	page,
}) => {
	let reads = 0;
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
		if (path.endsWith("/btw")) {
			reads += 1;
			await route.fulfill({
				status: reads === 1 ? 403 : 200,
				headers,
				json: reads === 1 ? { error: "Permission denied" } : [entry],
			});
			return;
		}
		await route.fulfill({
			headers,
			json: path.includes("background") ? { processes: [] } : {},
		});
	});
	await page.goto("/cowork-side-chats-proof.html");
	await page.getByRole("button", { name: /^Side chats/ }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not load side chats."
	);
	await page.getByRole("button", { name: "Retry side chats" }).click();
	await expect(
		page.getByRole("button", { name: /Why retain the saved answer/ })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(reads).toBe(2);
});

test("real pinned context controls dispatch the selected artifact, subagent, and complete inventories", async ({
	page,
}) => {
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		await route.fulfill({
			json: path.endsWith("/btw")
				? []
				: path.includes("background")
					? { processes: [] }
					: {},
		});
	});
	await page.goto("/cowork-side-chats-proof.html?context=1");
	await page.getByRole("button", { name: /^Rendered artifacts/ }).click();
	await page
		.getByRole("button", { name: "Web page HTML", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-side-chats-proof.tsx installs __contextAction before this proof page is evaluated. */ (
						window as Window & { __contextAction?: unknown }
					).__contextAction
			)
		)
		.toEqual({ kind: "artifact", content: "<h1>Reviewed result</h1>" });
	await page.getByRole("button", { name: "Open all sources" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-side-chats-proof.tsx installs __contextAction before this proof page is evaluated. */ (
						window as Window & { __contextAction?: unknown }
					).__contextAction
			)
		)
		.toEqual({ kind: "sources" });
	await page.getByRole("button", { name: "Open all subagents" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-side-chats-proof.tsx installs __contextAction before this proof page is evaluated. */ (
						window as Window & { __contextAction?: unknown }
					).__contextAction
			)
		)
		.toEqual({ kind: "subagents" });
	await page.getByRole("button", { name: /^Subagents 1/ }).click();
	await page.getByRole("button", { name: /Review context reviewer/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-side-chats-proof.tsx installs __contextAction before this proof page is evaluated. */ (
						window as Window & { __contextAction?: { id?: string } }
					).__contextAction?.id
			)
		)
		.toBe("fixture-subagent");
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.stringify(
					/* SAFETY: cowork-side-chats-proof.tsx installs __contextAction before this proof page is evaluated. */ (
						window as Window & { __contextAction?: unknown }
					).__contextAction
				)
			)
		)
		.toContain("Controls reviewed.");
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/pinned-context-actions.png",
		fullPage: true,
	});
});

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
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/pinned-environment-sync-complete.png",
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
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned/side-chat-identity-readback.png",
		fullPage: true,
	});
});

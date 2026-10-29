import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { z } from "zod";

test.describe.configure({ timeout: 90_000 });
const proofRoot =
	"../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/cowork-pinned";
const cwd = "/fixture/pinned-project";
const repository = {
	nameWithOwner: "fixture/reviewed",
	url: "https://fixture-links.test/fixture/reviewed",
	defaultBranch: "main",
};
const pull = {
	number: 42,
	title: "Reviewed request",
	url: "https://fixture-links.test/fixture/reviewed/pull/42",
	branch: "fixture/feature",
	base: "main",
	repository: "fixture/reviewed",
	state: "OPEN",
};
interface Mutation {
	body: unknown;
	path: string;
	token: string | undefined;
}
interface Backend {
	attempts: Map<string, number>;
	branch: string;
	deny: Set<string>;
	mutations: Mutation[];
	processes: boolean;
	pull: typeof pull | null;
	repo: boolean;
	repository: typeof repository | null;
}
async function backend(page: Page, options: Partial<Backend> = {}) {
	const state: Backend = {
		repo: true,
		branch: "fixture/feature",
		repository: null,
		pull: null,
		processes: false,
		mutations: [],
		deny: new Set(),
		attempts: new Map(),
		...options,
	};
	await page.route("http://side-chat-fixture.test/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const headers = {
			"access-control-allow-origin": "*",
			"access-control-allow-headers": "*",
			"access-control-allow-methods": "*",
		};
		const reply = <Payload>(json: Payload, status = 200) =>
			route.fulfill({ headers, json, status });
		if (request.method() === "OPTIONS") {
			await route.fulfill({ headers, status: 204 });
			return;
		}
		if (request.method() === "POST") {
			const body = request.postDataJSON();
			state.mutations.push({
				path,
				body,
				token: request.headers().authorization,
			});
			const attempt = (state.attempts.get(path) ?? 0) + 1;
			state.attempts.set(path, attempt);
			if (state.deny.has(path) && attempt === 1) {
				await reply({ error: "Fixture action denied" }, 403);
				return;
			}
			if (path === "/api/git/init") {
				state.repo = true;
				await reply({ success: true, initialized: true });
				return;
			}
			if (path === "/api/git/checkout") {
				state.branch = z.object({ branch: z.string() }).parse(body).branch;
				await reply({ success: true });
				return;
			}
			if (path.endsWith("/repository/create")) {
				state.repository = repository;
				await reply({ repository });
				return;
			}
			if (path === "/api/git/pull-request") {
				state.pull = pull;
				await reply({
					success: true,
					pr_url: "https://fixture-links.test/request-result",
					title: "Reviewed request",
				});
				return;
			}
			if (path.endsWith("/stop")) {
				state.processes = false;
				await reply({
					ok: true,
					requested: true,
					process_id: "worker/fixture",
				});
				return;
			}
			await reply({ success: true, committed: true, commit: "fixture-head" });
			return;
		}
		if (path === "/api/git/status") {
			await reply({
				is_repo: state.repo,
				branch: state.branch,
				dirty: false,
				changed_files_count: 0,
				insertions: 0,
				deletions: 0,
				ahead: 1,
				behind: 0,
			});
			return;
		}
		if (path === "/api/git/branches") {
			await reply({
				is_repo: state.repo,
				current: state.branch,
				branches: ["fixture/feature", "fixture/other", "main"],
			});
			return;
		}
		if (path.endsWith("/repository")) {
			await reply({ repository: state.repository });
			return;
		}
		if (path.includes("/pulls/branch")) {
			await reply({ pull: state.pull });
			return;
		}
		if (path.endsWith("/btw")) {
			await reply([]);
			return;
		}
		if (path === "/api/background/processes") {
			await reply({
				processes: state.processes
					? [
							{
								process_id: "worker/fixture",
								command: "fixture-worker",
								label: "Reviewed worker",
								cwd,
								elapsed_ms: 7000,
								kind: "shell",
								producer: "fixture",
								running: true,
								started_at: 1_790_000_000_000,
							},
						]
					: [],
			});
			return;
		}
		if (path.includes("worktree")) {
			await reply({
				active: false,
				files: [],
				has_changes: false,
				changed_files: 0,
			});
			return;
		}
		await reply({});
	});
	return state;
}
async function ensureEnvironmentOpen(page: Page) {
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
async function openEnvironment(page: Page, query = "project=1") {
	await page.goto(`/cowork-side-chats-proof.html?${query}`);
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
async function contextAction(page: Page) {
	return page.evaluate(
		() =>
			/* SAFETY: cowork-side-chats-proof.tsx installs __contextAction before this proof page is evaluated. */ (
				window as Window & { __contextAction?: unknown }
			).__contextAction
	);
}
async function clickExternal(
	context: BrowserContext,
	page: Page,
	name: string,
	expectedUrl: string
) {
	await context.route("https://fixture-links.test/**", (route) =>
		route.fulfill({ body: "Fixture destination", contentType: "text/plain" })
	);
	const link = page.getByRole("link", { name, exact: true });
	await expect(link).toHaveAttribute("href", expectedUrl);
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", /noopener/);
	const popupPromise = context.waitForEvent("page");
	await link.click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL(expectedUrl);
	await popup.close();
}

test("real context source links, overflow and activity chips invoke the selected targets", async ({
	page,
}) => {
	await backend(page);
	await page.addInitScript(() => {
		const calls: { command: string; args?: unknown }[] = [];
		const fixtureWindow =
			/* SAFETY: This fixture initialization defines __nativeCalls on its own browser window. */ window as Window & {
				__nativeCalls?: typeof calls;
				__TAURI_INTERNALS__?: unknown;
			};
		fixtureWindow.__nativeCalls = calls;
		fixtureWindow.__TAURI_INTERNALS__ = {
			transformCallback: () => 1,
			invoke: async <Args>(command: string, args?: Args) => {
				calls.push({ command, args });
				if (command === "open_external") {
					return null;
				}
				if (command === "plugin:event|listen") {
					return 1;
				}
				return null;
			},
		};
	});
	await page.goto("/cowork-side-chats-proof.html?controls=1");
	await page
		.getByRole("button", { name: "Open Review control 5 subagent task" })
		.click();
	await expect
		.poll(() => contextAction(page))
		.toMatchObject({ kind: "subagent", id: "control-subagent-5" });
	await page.getByRole("button", { name: /^Sources/ }).click();
	await page.getByRole("button", { name: /^Web search/ }).click();
	await page.getByRole("button", { name: /source-0/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-pinned-controls-proof.spec.ts installs __nativeCalls before this proof page is evaluated. */ (
						window as Window & { __nativeCalls?: unknown[] }
					).__nativeCalls
			)
		)
		.toContainEqual({
			command: "open_external",
			args: { url: "https://fixture-links.test/source-0" },
		});
	await page.getByRole("button", { name: /\+1 more items/ }).click();
	await expect.poll(() => contextAction(page)).toEqual({ kind: "sources" });
	await page.getByRole("button", { name: /^Subagents 6/ }).click();
	await page.getByRole("button", { name: /\+1 more subagents/ }).click();
	await expect.poll(() => contextAction(page)).toEqual({ kind: "subagents" });
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-context-overflow-links.png`,
		fullPage: true,
	});
});

test("real Environment keeps no-folder state read-only and selects branch and run mode", async ({
	page,
}) => {
	const state = await backend(page, { deny: new Set(["/api/git/checkout"]) });
	await openEnvironment(page, "");
	await expect(page.getByTestId("pinned-summary-folder")).toHaveText(
		"No project folder"
	);
	await expect(
		page.getByText(
			"No project folder is attached to this chat yet. A local-file request will ask you to choose one."
		)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Commit or push", exact: true })
	).toHaveCount(0);
	await openEnvironment(page);
	await expect(page.getByTestId("pinned-summary-folder")).toHaveText(
		"pinned-project"
	);
	await page.getByTitle("Branch: fixture/feature", { exact: true }).click();
	await page
		.getByRole("option", { name: "fixture/other", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("Fixture action denied");
	expect(state.branch).toBe("fixture/feature");
	await page
		.getByRole("option", { name: "fixture/other", exact: true })
		.click();
	await expect(
		page.getByTitle("Branch: fixture/other", { exact: true })
	).toBeVisible();

	await page
		.getByTitle("Choose where this chat works", { exact: true })
		.click();
	await page.getByRole("option", { name: "New worktree", exact: true }).click();
	await expect
		.poll(() => contextAction(page))
		.toEqual({ kind: "mode", enabled: true });
	await page.keyboard.press("Escape");
	const modeTrigger = page.getByTitle("Choose where this chat works", {
		exact: true,
	});
	await expect(modeTrigger).toHaveAttribute("aria-expanded", "false");
	await modeTrigger.focus();
	await modeTrigger.press("Enter");
	await expect(modeTrigger).toHaveAttribute("aria-expanded", "true");
	await page
		.getByRole("dialog", { name: "Choose where this chat works" })
		.getByRole("option", { name: "Local", exact: true })
		.click();
	await expect
		.poll(() => contextAction(page))
		.toEqual({ kind: "mode", enabled: false });
	expect(state.mutations).toEqual(
		[1, 2].map(() => ({
			path: "/api/git/checkout",
			body: { cwd, branch: "fixture/other" },
			token: "Bearer fixture-node-token",
		}))
	);
	await page.reload();
	await ensureEnvironmentOpen(page);
	await expect(
		page.getByTitle("Branch: fixture/other", { exact: true })
	).toBeVisible();
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-environment-branch-mode.png`,
		fullPage: true,
	});
});

test("real Environment interrupts a running chat before arming the requested handoff", async ({
	page,
}) => {
	const state = await backend(page);
	await openEnvironment(page, "project=1&running=1");
	await page
		.getByRole("button", { name: "Hand off to worktree", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("alert")).toContainText(
		"interrupt the current response"
	);
	await dialog
		.getByRole("textbox", { name: "Branch name", exact: true })
		.fill("  fixture/review-handoff  ");
	await dialog.getByRole("button", { name: "Hand off", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect
		.poll(() => contextAction(page))
		.toEqual({
			kind: "handoff",
			branch: "fixture/review-handoff",
			interrupted: true,
		});
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: cowork-side-chats-proof.tsx initializes and appends actual context actions in this private unknown-element array. This test observes the optional holder and compares the concrete expected interrupt/handoff values. */ (
						window as Window & { __contextActions?: unknown[] }
					).__contextActions
			)
		)
		.toEqual([
			{ kind: "interrupt" },
			{ kind: "handoff", branch: "fixture/review-handoff", interrupted: true },
		]);
	expect(state.mutations).toEqual([]);
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-environment-handoff.png`,
		fullPage: true,
	});
});

test("real Environment initializes local Git after denial and reads back the repository", async ({
	page,
}) => {
	const state = await backend(page, {
		repo: false,
		deny: new Set(["/api/git/init"]),
	});
	await openEnvironment(page);
	await page
		.getByRole("button", { name: "Create local Git", exact: true })
		.click();
	await expect(page.getByText("Fixture action denied")).toBeVisible();
	expect(state.repo).toBe(false);
	await page
		.getByRole("button", { name: "Create local Git", exact: true })
		.click();
	await expect(
		page.getByText("Local Git ready", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create local Git", exact: true })
	).not.toBeVisible();
	expect(state.mutations).toEqual(
		[1, 2].map(() => ({
			path: "/api/git/init",
			body: { cwd },
			token: "Bearer fixture-node-token",
		}))
	);
	await page.reload();
	await ensureEnvironmentOpen(page);
	await expect(
		page.getByTitle("Branch: fixture/feature", { exact: true })
	).toBeVisible();
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-environment-local-git.png`,
		fullPage: true,
	});
});

test("real pinned background process stop preserves denied work and retries to persisted removal", async ({
	page,
}) => {
	const path = "/api/background/processes/worker%2Ffixture/stop";
	const state = await backend(page, { processes: true, deny: new Set([path]) });
	await page.goto("/cowork-side-chats-proof.html");
	await page.getByRole("button", { name: /^Background processes 1/ }).click();
	await page
		.getByRole("button", { name: "Stop Reviewed worker", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not stop process. Try again."
	);
	await expect(
		page.getByText("Reviewed worker", { exact: true })
	).toBeVisible();
	expect(state.processes).toBe(true);
	await page
		.getByRole("button", { name: "Stop Reviewed worker", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: /^Background processes/ })
	).not.toBeVisible();
	expect(state.mutations).toEqual(
		[1, 2].map(() => ({ path, body: {}, token: "Bearer fixture-node-token" }))
	);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Environment", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /^Background processes/ })
	).not.toBeVisible();
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-background-stop-readback.png`,
		fullPage: true,
	});
});

test("real Environment repository creation retains denial, retries and opens safe provider links", async ({
	page,
	context,
}) => {
	const path = "/api/ext/@ryu/pull-requests/repository/create";
	const state = await backend(page, { deny: new Set([path]) });
	await openEnvironment(page, "project=1&github=1");
	await page
		.getByRole("button", { name: "Create GitHub repository", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "GitHub repository name" })
		.fill("reviewed");
	await dialog.getByRole("radio", { name: "Public repository" }).click();
	await dialog
		.getByRole("button", { name: "Create and push", exact: true })
		.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"Check the GitHub account permissions"
	);
	await expect(
		dialog.getByRole("textbox", { name: "GitHub repository name" })
	).toHaveValue("reviewed");
	await expect(
		dialog.getByRole("radio", { name: "Public repository" })
	).toBeChecked();
	expect(state.repository).toBeNull();
	await dialog
		.getByRole("button", { name: "Create and push", exact: true })
		.click();
	await expect(dialog).not.toBeVisible();
	await clickExternal(
		context,
		page,
		"Published fixture/reviewed",
		repository.url
	);
	await clickExternal(
		context,
		page,
		"Compare branch",
		`${repository.url}/compare/main...fixture%2Ffeature?expand=1`
	);
	expect(state.mutations).toEqual(
		[1, 2].flatMap(() => [
			{
				path: "/api/git/commit-push",
				body: {
					cwd,
					message: "Initial commit",
					action: "commit",
					include_unstaged: true,
				},
				token: "Bearer fixture-node-token",
			},
			{
				path,
				body: { cwd, name: "reviewed", visibility: "public" },
				token: "Bearer fixture-node-token",
			},
		])
	);
	await page.reload();
	await ensureEnvironmentOpen(page);
	await expect(
		page.getByRole("button", { name: "Create GitHub repository", exact: true })
	).not.toBeVisible();
	await expect(
		page.getByRole("link", { name: "Compare branch", exact: true })
	).toHaveAttribute(
		"href",
		`${repository.url}/compare/main...fixture%2Ffeature?expand=1`
	);
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-repository-provider-readback.png`,
		fullPage: true,
	});
});

test("real Environment PR submission preserves fields after denial and reads back provider identity", async ({
	page,
	context,
}) => {
	const path = "/api/git/pull-request";
	const state = await backend(page, { repository, deny: new Set([path]) });
	await openEnvironment(page);
	await page
		.getByRole("button", { name: "Create pull request", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request title" })
		.fill("Reviewed request");
	await dialog
		.getByRole("textbox", { name: "Pull request description" })
		.fill("Verified controls.");
	await dialog.getByRole("button", { name: "Create PR", exact: true }).click();
	await expect(dialog.getByText("Fixture action denied")).toBeVisible();
	await expect(
		dialog.getByRole("textbox", { name: "Pull request title" })
	).toHaveValue("Reviewed request");
	await expect(
		dialog.getByRole("textbox", { name: "Pull request description" })
	).toHaveValue("Verified controls.");
	expect(state.pull).toBeNull();
	await dialog.getByRole("button", { name: "Create PR", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await clickExternal(
		context,
		page,
		"PR created",
		"https://fixture-links.test/request-result"
	);
	expect(state.mutations).toEqual(
		[1, 2].map(() => ({
			path,
			body: {
				cwd,
				base: "main",
				body: "Verified controls.",
				draft: false,
				include_unstaged: true,
				title: "Reviewed request",
			},
			token: "Bearer fixture-node-token",
		}))
	);
	await openEnvironment(page, "project=1&github=1");
	await expect(
		page.getByText("Reviewed request", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create pull request", exact: true })
	).not.toBeVisible();
	// Let the accordion spring settle before capturing the completed surface.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: `${proofRoot}/pinned-pr-provider-readback.png`,
		fullPage: true,
	});
});

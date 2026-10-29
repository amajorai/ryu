import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

const patch = (name: string) =>
	`diff --git a/src/${name}.ts b/src/${name}.ts\nindex 1111111..2222222 100644\n--- a/src/${name}.ts\n+++ b/src/${name}.ts\n@@ -1 +1 @@\n-export const ${name} = 'before';\n+export const ${name} = 'after';`;
interface Write {
	auth: string | undefined;
	body: unknown;
	path: string;
}
async function setup(
	page: Page,
	outcomes: { status: number; body: unknown }[],
	query = ""
) {
	const writes: Write[] = [];
	let reads = 0;
	await page.route("**/api/worktree/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path.endsWith("/apply")) {
			writes.push({
				body: request.postDataJSON(),
				auth: request.headers().authorization,
				path,
			});
			const outcome = outcomes.shift();
			if (!outcome) {
				throw new Error("Unexpected duplicate write");
			}
			await route.fulfill({ status: outcome.status, json: outcome.body });
		} else if (path.endsWith("/status")) {
			await route.fulfill({
				json: {
					active: true,
					branch: "ryu/review",
					path: "/fixture/review",
					changed_files: 2,
					has_changes: true,
				},
			});
		} else if (path.endsWith("/diff")) {
			reads++;
			const saved = await page.evaluate(
				() =>
					/* SAFETY: diff-review-proof.tsx installs __diffBridgeCalls before this proof page is evaluated. */ (
						window as Window & {
							__diffBridgeCalls?: {
								command: string;
								args?: { content?: string };
							}[];
						}
					).__diffBridgeCalls
						?.filter((c) => c.command === "write_project_file")
						.at(1)?.args?.content ?? null
			);
			const alphaPatch = saved
				? patch("alpha").replace("@@ -1 +1 @@", "@@ -1 +1,2 @@") +
					"\n+// reviewed"
				: patch("alpha");
			await route.fulfill({
				json: {
					has_changes: true,
					files: ["alpha", "beta"].map((name) => ({
						path: `src/${name}.ts`,
						kind: "modified",
						additions: name === "alpha" && saved ? 2 : 1,
						deletions: 1,
					})),
					unified_diff: `${alphaPatch}\n${patch("beta")}\n`,
				},
			});
		} else {
			throw new Error(`Unexpected request ${path}`);
		}
	});
	await page.addInitScript(() => localStorage.clear());
	await page.goto(`/diff-review-proof.html${query}`);
	await expect(page.getByRole("button", { name: /^Changes/ })).toBeVisible();
	if (
		!(await page.getByRole("button", { name: "Apply (merge)" }).isVisible())
	) {
		await page.getByRole("button", { name: /^Changes/ }).click();
	}
	await expect(
		page.getByRole("button", { name: "Apply (merge)" })
	).toBeVisible();
	return { writes, readCount: () => reads };
}
test("production Changes caller selects exact files, filters and collapses without losing selection", async ({
	page,
}) => {
	const state = await setup(page, []);
	await page.getByRole("button", { name: /beta.ts/ }).hover();
	await expect(page.getByText("Preview", { exact: true })).toBeVisible();
	await page
		.getByRole("button", { name: /beta.ts/ })
		.locator("span")
		.filter({ hasText: /^beta.ts$/ })
		.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
		"src/beta.ts"
	);
	await page.getByRole("button", { name: /beta.ts/ }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: diff-review-proof.tsx installs __diffBridgeCalls before this proof page is evaluated. */ (
						window as Window & {
							__diffBridgeCalls: { command: string; args: { path: string } }[];
						}
					).__diffBridgeCalls
						.filter((c) => c.command === "read_git_project_file")
						.at(-1)?.args.path
			)
		)
		.toBe("src/beta.ts");
	await page
		.getByRole("textbox", { name: "Filter changed files" })
		.fill("NO SUCH FILE");
	await expect(page.getByText("No matching files")).toBeVisible();
	await page
		.getByRole("textbox", { name: "Filter changed files" })
		.fill("ALPHA");
	await expect(page.getByRole("button", { name: /alpha.ts/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /beta.ts/ })).toHaveCount(0);
	await page.getByRole("button", { name: /2 files changed/ }).click();
	await expect(
		page.getByRole("textbox", { name: "Filter changed files" })
	).toHaveCount(0);
	await page.getByRole("button", { name: /2 files changed/ }).click();
	await expect(
		page.getByRole("textbox", { name: "Filter changed files" })
	).toHaveValue("ALPHA");
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Editing", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	expect(state.writes).toEqual([]);
});
test("merge denial remains retryable and successful retry refreshes authoritative diff", async ({
	page,
}) => {
	const state = await setup(page, [
		{ status: 403, body: { error: "Write permission denied" } },
		{
			status: 200,
			body: { success: true, commit: "abcdef0123456789", pr_url: null },
		},
	]);
	await page.getByRole("button", { name: "Apply (merge)" }).click();
	await expect(
		page.getByText("Write permission denied", { exact: false })
	).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const before = state.readCount();
	await page.getByRole("button", { name: "Apply (merge)" }).click();
	await expect(page.getByText("Merged", { exact: false })).toBeVisible();
	await expect.poll(state.readCount).toBeGreaterThan(before);
	expect(state.writes).toEqual(
		[1, 2].map(() => ({
			path: "/api/worktree/review%2Frun/apply",
			auth: "Bearer diff-review-fixture",
			body: { mode: "merge", message: "Applied run review/run" },
		}))
	);
	await mkdir(
		"../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-diff",
		{ recursive: true }
	);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-diff/merged.png",
		fullPage: true,
	});
});
test("conflict displays exact affected paths and prevents duplicate application", async ({
	page,
}) => {
	const state = await setup(page, [
		{
			status: 409,
			body: {
				success: false,
				error: "merge_conflict",
				conflicted_files: ["src/beta.ts"],
			},
		},
	]);
	await page.getByRole("button", { name: "Apply (merge)" }).click();
	await expect(
		page.getByText("Merge conflict — worktree cleaned up safely")
	).toBeVisible();
	await expect(
		page.locator("li").filter({ hasText: "src/beta.ts" })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Apply (merge)" })).toHaveCount(
		0
	);
	expect(state.writes).toHaveLength(1);
});
test("PR mode sends exact request and exposes safe returned destination", async ({
	page,
}) => {
	const state = await setup(page, [
		{
			status: 200,
			body: {
				success: true,
				commit: null,
				pr_url: "https://git.example.test/team/repo/pulls/7",
			},
		},
	]);
	await page.getByRole("button", { name: "Open PR", exact: true }).click();
	const link = page.getByRole("link", {
		name: "https://git.example.test/team/repo/pulls/7",
	});
	await expect(link).toHaveAttribute(
		"href",
		"https://git.example.test/team/repo/pulls/7"
	);
	await expect(link).toHaveAttribute("rel", "noopener noreferrer");
	expect(state.writes[0]?.body).toEqual({
		mode: "pr",
		message: "Applied run review/run",
	});
});

test("failed file save preserves draft and retries exact selected working file with readback", async ({
	page,
}) => {
	const state = await setup(page, []);
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	const editor = page.locator('[contenteditable="true"]').first();
	await expect(editor).toBeVisible();
	await editor.click();
	await editor.press("ControlOrMeta+End");
	await editor.press("Enter");
	await editor.pressSequentially("// reviewed");
	await page.getByRole("button", { name: "Save file", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText("File permission denied");
	await expect(page.getByText("Unsaved edits")).toBeVisible();
	const before = state.readCount();
	await page.getByRole("button", { name: "Save file", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect.poll(state.readCount).toBeGreaterThan(before);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: diff-review-proof.tsx installs __diffBridgeCalls before this proof page is evaluated. */ (
						window as Window & {
							__diffBridgeCalls: {
								command: string;
								args: { path: string; content: string };
							}[];
						}
					).__diffBridgeCalls.filter((c) => c.command === "write_project_file")
						.length
			)
		)
		.toBe(2);
	const calls = await page.evaluate(
		() =>
			/* SAFETY: diff-review-proof.tsx installs __diffBridgeCalls before this proof page is evaluated. */ (
				window as Window & {
					__diffBridgeCalls: {
						command: string;
						args: { path: string; content: string };
					}[];
				}
			).__diffBridgeCalls
	);
	const writes = calls.filter((c) => c.command === "write_project_file");
	expect(writes[0]?.args.path).toBe("/fixture/review/src/alpha.ts");
	expect(writes[0]?.args.content).toContain("// reviewed");
	expect(writes[1]).toEqual(writes[0]);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: diff-review-proof.tsx installs __diffBridgeCalls before this proof page is evaluated. */ (
						window as Window & { __diffBridgeCalls: { command: string }[] }
					).__diffBridgeCalls.filter((c) => c.command === "read_project_file")
						.length
			)
		)
		.toBeGreaterThan(1);
	await expect(page.getByText("Unsaved edits")).toHaveCount(0);
	await page.screenshot({
		path: "../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-diff/saved-readback.png",
		fullPage: true,
	});
});

test("pending merge prevents repeated merge or PR writes", async ({ page }) => {
	let release: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = await setup(page, [
		{
			status: 200,
			body: { success: true, commit: "abcdef0123456789", pr_url: null },
		},
	]);
	await page.route("**/api/worktree/**/apply", async (route) => {
		await pending;
		await route.fallback();
	});
	await page.getByRole("button", { name: "Apply (merge)" }).click();
	await expect(page.getByText("Merging…")).toBeVisible();
	await expect(page.getByRole("button", { name: "Apply (merge)" })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("button", { name: "Open PR", exact: true })
	).toHaveCount(0);
	release?.();
	await expect(page.getByText("Merged", { exact: false })).toBeVisible();
	expect(state.writes).toHaveLength(1);
});
test("untrusted returned PR URL is never executable", async ({ page }) => {
	await setup(page, [
		{
			status: 200,
			body: { success: true, commit: null, pr_url: "javascript:alert(1)" },
		},
	]);
	await page.getByRole("button", { name: "Open PR", exact: true }).click();
	await expect(
		page.getByText("javascript:alert(1)", { exact: true })
	).toBeVisible();
	await expect(
		page.locator("a").filter({ hasText: "javascript:alert(1)" })
	).not.toHaveAttribute("href");
});

test("late prior-file read cannot overwrite the newly selected file", async ({
	page,
}) => {
	await setup(page, [], "?hold");
	await expect
		.poll(() =>
			page.evaluate(() =>
				Boolean(
					/* SAFETY: diff-review-proof.tsx installs __diffReleaseRead before this proof page is evaluated. */ (
						window as Window & { __diffReleaseRead?: () => void }
					).__diffReleaseRead
				)
			)
		)
		.toBe("function");
	await page.getByRole("button", { name: /beta.ts/ }).click();
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	const editor = page.locator('[contenteditable="true"]').first();
	await expect(editor).toContainText("export const beta");
	await page.evaluate(() =>
		/* SAFETY: diff-review-proof.tsx installs __diffReleaseRead before this proof page is evaluated. */ (
			window as Window & { __diffReleaseRead?: () => void }
		).__diffReleaseRead?.()
	);
	await expect(editor).toContainText("export const beta");
	await expect(editor).not.toContainText("export const alpha");
});

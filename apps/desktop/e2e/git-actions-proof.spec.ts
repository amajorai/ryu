import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/git-actions-proof.html";

async function closeCommitDialog(page: Page) {
	const message = page.getByPlaceholder(
		"Commit message (leave blank to generate)…"
	);
	await expect(message).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(message).toBeHidden();
}

test("matches the commit and push dialog reference options", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeVisible();
	await expect(page.getByText("Include unstaged changes")).toBeVisible();
	await expect(
		page.getByRole("checkbox", {
			name: "Include unstaged changes +76,383 −8,438",
		})
	).toBeVisible();
	for (const label of [/^Commit(?: ⌘↵)?$/, "Commit and push", "Push"]) {
		await expect(
			page.getByRole("button", { name: label, exact: true })
		).toBeVisible();
	}
	await closeCommitDialog(page);
	await page.getByRole("button", { name: "Pull latest changes" }).click();
	await expect(page.getByText("Pulling…", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Stop git action" })
	).toHaveCount(0);
	await page.reload();
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeHidden();
	await page.getByRole("button", { name: "Sync with remote" }).click();
	await expect(page.getByText("Syncing…", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Stop git action" })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-remote-sync-no-stop-proof.png"),
	});
	await page.reload();
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByPlaceholder("Commit message (leave blank to generate)…")
	).toBeHidden();

	await page.getByTestId("show-generating").click();
	await expect(
		page.getByText("Generating message…", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Stop git action" }).click();
	await expect(page.getByText("Commit or push is ready.")).toBeVisible();
	await page.getByTestId("open-commit-dialog").click();

	await page.getByRole("button", { name: /^Commit(?: ⌘↵)?$/ }).click();
	await expect(page.getByText("Committing…", { exact: true })).toBeVisible();
});

test("matches the create pull request dialog reference options", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await closeCommitDialog(page);
	await page.getByTestId("open-pr-dialog").click();

	await expect(
		page.getByText("codex/gateway-posture-doctor → main")
	).toBeVisible();
	await expect(page.getByPlaceholder("Title")).toBeVisible();
	await expect(
		page.getByPlaceholder("Description (leave empty to generate)")
	).toBeVisible();
	await expect(page.getByText("Commit and push local changes")).toBeVisible();
	for (const label of ["Create draft PR", /^Create PR/, "Open PR in browser"]) {
		await expect(
			page.getByRole("button", { name: label, exact: true })
		).toBeVisible();
	}
});

test("shows the GitHub PR and CI rollup in the environment and chat hover", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await closeCommitDialog(page);

	const summary = page.getByTestId("pr-ci-summary");
	await expect(summary).toContainText("Harden Gateway posture checks");
	await expect(summary).toContainText("4 failing checks");
	await expect(summary).toContainText("3 comments");
	await expect(
		summary.getByTestId("pull-request-status-icon-552")
	).toHaveAttribute("data-status", "open");
	await expect(
		page.getByTestId("code-mode-pr-statuses").locator('[role="img"]')
	).toHaveCount(4);
	for (const status of ["open", "draft", "closed", "merged"]) {
		await expect(
			page
				.getByTestId("code-mode-pr-statuses")
				.locator(`[data-status="${status}"]`)
		).toBeVisible();
	}
	await expect(
		summary.getByRole("link", { name: /Open pull request/ })
	).toHaveAttribute("href", "https://github.com/amajorai/ryu/pull/552");
	await summary.getByRole("button", { name: "Fix" }).click();
	await expect(page.getByTestId("ci-report-attached")).toHaveText(
		"Attached ci-failures-pr-552.txt"
	);

	await page.getByTestId("sidebar-chat-trigger").hover();
	const hoverSummary = page.getByTestId("pull-request-summary-552").last();
	await expect(hoverSummary).toBeVisible();
	await expect(hoverSummary).toContainText("4 failing checks");
	await expect(hoverSummary).toContainText("3 comments");

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("git-pull-sync-proof.png"),
	});
});

for (const theme of ["light", "dark"]) {
	test(`Git dialogs support keyboard input and narrow windows in ${theme}`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 390, height: 640 });
		await page.goto(`${STORY_URL}?theme=${theme}`);
		const dialog = page.getByRole("dialog");
		await page
			.getByRole("button", {
				name: "Commit to codex/gateway-posture-doctor",
				exact: true,
			})
			.click();
		await page.getByRole("menuitem", { name: "main", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Commit to main", exact: true })
		).toBeVisible();
		const message = page.getByRole("textbox", {
			name: "Commit message",
			exact: true,
		});
		await message.fill("Use shared Git controls");
		await expect(message).toHaveValue("Use shared Git controls");
		await message.press("Tab");
		await expect(
			page.getByRole("checkbox", { name: /Include unstaged changes/ })
		).toBeFocused();
		await page.keyboard.press("Space");
		await expect(
			page.getByRole("checkbox", { name: /Include unstaged changes/ })
		).not.toBeChecked();
		const assertContained = async () => {
			await expect(dialog).toBeVisible();
			await expect
				.poll(async () => {
					const bounds = await dialog.boundingBox();
					return (
						bounds !== null &&
						bounds.x >= 0 &&
						bounds.y >= 0 &&
						bounds.x + bounds.width <= 390.5 &&
						bounds.y + bounds.height <= 640.5
					);
				})
				.toBe(true);
			expect(
				await dialog.evaluate(
					(element) => element.scrollWidth <= element.clientWidth
				)
			).toBe(true);
		};
		await assertContained();
		await page.screenshot({
			path: `../test-results/git-commit-${theme}-narrow.png`,
		});
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await page.getByTestId("open-pr-dialog").click();
		await page
			.getByRole("textbox", { name: "Pull request title", exact: true })
			.fill("Use shared controls");
		await page
			.getByRole("textbox", { name: "Pull request description", exact: true })
			.fill("Keep fields and actions accessible in small windows.");
		await assertContained();
		await page
			.getByRole("button", { name: "Open PR in browser", exact: true })
			.scrollIntoViewIfNeeded();
		await expect(
			page.getByRole("button", { name: "Open PR in browser", exact: true })
		).toBeInViewport();
		await page.screenshot({
			path: `../test-results/git-pr-${theme}-narrow.png`,
		});
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: "Open repository dialog", exact: true })
			.click();
		await page
			.getByRole("textbox", { name: "GitHub repository name", exact: true })
			.fill("design-proof");
		await assertContained();
		await page.screenshot({
			path: `../test-results/git-repository-${theme}-narrow.png`,
		});
		expect(errors).toEqual([]);
	});
}

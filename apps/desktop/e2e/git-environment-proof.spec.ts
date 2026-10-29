import { expect, test } from "@playwright/test";

const STORY_URL = "/git-environment-proof.html";

test("walks the Ryu Work local Git to GitHub publish flow", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("git-environment-proof")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create local Git" })
	).toBeVisible();
	await expect(page.getByTestId("compare-branch-link")).toHaveCount(0);

	await page.getByRole("button", { name: "Create local Git" }).click();
	await expect(page.getByTestId("environment-card")).toContainText("Git ready");
	await expect(page.getByTestId("compare-branch-link")).toHaveAttribute(
		"href",
		"https://github.com/amajorai/ryu/compare/main...feature%2Fcompare?expand=1"
	);

	await page.getByTestId("create-github-repository").click();
	await expect(
		page.getByTestId("create-github-repository-dialog")
	).toBeVisible();
	await page.getByLabel("GitHub repository name").fill("ryu-workspace");
	await page.getByRole("radio", { name: "Public repository" }).click();
	await expect(
		page.getByRole("radio", { name: "Public repository" })
	).toBeChecked();
	await page.screenshot({
		path: test.info().outputPath("git-environment-proof.png"),
		fullPage: true,
	});

	await page.getByRole("button", { name: "Create and push" }).click();
	await expect(page.getByTestId("flow-status")).toContainText(
		"public repository"
	);
});

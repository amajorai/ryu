// Continues git-actions-stateful-proof.spec.ts (split under the file token limit); helpers live in git-actions-stateful-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	capture,
	closeCommitDialog,
	installGitFixture,
	mutationRequests,
	openProofPage,
	WORKSPACE,
} from "./git-actions-stateful-proof.helpers.ts";

test("pull request draft, create, and browser-target actions preserve options and retry state", async ({
	page,
}) => {
	const fixture = await installGitFixture(page, {
		failOnce: ["/api/git/pull-request"],
	});
	await openProofPage(page);
	await closeCommitDialog(page);
	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	const pullRequestDialog = page.getByRole("dialog", {
		name: "Create pull request",
	});
	const title = page.getByRole("textbox", {
		name: "Pull request title",
		exact: true,
	});
	const description = page.getByRole("textbox", {
		name: "Pull request description",
		exact: true,
	});
	const commitWithPr = page.getByRole("checkbox", {
		name: /Commit and push local changes/,
	});
	await title.fill("Fixture draft title");
	await description.fill("Verify the failure and retry path.");
	await expect(commitWithPr).toBeChecked();
	await commitWithPr.click();
	await expect(commitWithPr).not.toBeChecked();
	await pullRequestDialog.getByRole("button", { name: "Close" }).click();
	await expect(pullRequestDialog).toBeHidden();
	expect(mutationRequests(fixture)).toEqual([]);

	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	await expect(title).toHaveValue("Fixture draft title");
	await expect(description).toHaveValue("Verify the failure and retry path.");
	await page
		.getByRole("button", { name: "Create draft PR", exact: true })
		.click();
	await expect(
		pullRequestDialog.getByText("fixture transient failure", { exact: true })
	).toBeVisible();
	await expect(title).toHaveValue("Fixture draft title");
	await capture(page, "desktop-git-actions-pull-request-retry.png");
	await page
		.getByRole("button", { name: "Create draft PR", exact: true })
		.click();
	await expect(pullRequestDialog).toBeHidden();
	await expect(page.getByTestId("pull-request-readback")).toContainText(
		"draft · Fixture draft title"
	);

	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	await title.fill("Fixture ready title");
	await description.fill("Create a non-draft pull request.");
	await commitWithPr.click();
	await expect(commitWithPr).toBeChecked();
	await page.getByRole("button", { name: "Create PR", exact: true }).click();
	await expect(pullRequestDialog).toBeHidden();
	await expect(page.getByTestId("pull-request-readback")).toContainText(
		"ready · Fixture ready title"
	);

	await page.getByRole("button", { name: "Open pull request dialog" }).click();
	await title.fill("Fixture browser target");
	await description.fill("Capture the URL without opening an external site.");
	await page
		.getByRole("button", { name: "Open PR in browser", exact: true })
		.click();
	await expect(pullRequestDialog).toBeHidden();
	await expect(page.getByTestId("external-url-requested")).toContainText(
		"https://github.com/fixture-owner/git-actions-fixture/pull/554"
	);
	const nativeCalls = z
		.array(
			z.object({
				args: z.record(z.string(), z.json()).optional(),
				command: z.string(),
			})
		)
		.parse(
			JSON.parse(
				(await page.getByTestId("tauri-native-calls").textContent()) ?? "[]"
			)
		);
	expect(
		nativeCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: {
				url: "https://github.com/fixture-owner/git-actions-fixture/pull/554",
			},
			command: "open_external",
		},
	]);
	await expect(page.getByTestId("pull-request-readback")).toContainText(
		"ready · Fixture browser target"
	);
	await capture(page, "desktop-git-actions-pull-request-readback.png");

	const mutationPayloads = mutationRequests(fixture)
		.filter((request) => request.pathname === "/api/git/pull-request")
		.map((request) => request.body);
	expect(mutationPayloads).toEqual([
		{
			base: "main",
			body: "Verify the failure and retry path.",
			cwd: WORKSPACE,
			draft: true,
			include_unstaged: false,
			title: "Fixture draft title",
		},
		{
			base: "main",
			body: "Verify the failure and retry path.",
			cwd: WORKSPACE,
			draft: true,
			include_unstaged: false,
			title: "Fixture draft title",
		},
		{
			base: "main",
			body: "Create a non-draft pull request.",
			cwd: WORKSPACE,
			draft: false,
			include_unstaged: true,
			title: "Fixture ready title",
		},
		{
			base: "main",
			body: "Capture the URL without opening an external site.",
			cwd: WORKSPACE,
			draft: false,
			include_unstaged: true,
			title: "Fixture browser target",
		},
	]);
	expect(
		fixture.requests.filter((request) =>
			request.pathname.endsWith("/pulls/branch")
		)
	).toHaveLength(3);
	expect(fixture.outsideRequests).toEqual([]);
});

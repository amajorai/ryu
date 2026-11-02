// Continues pull-requests-companion-proof.spec.ts (split under the file token limit); helpers live in pull-requests-companion-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	callsWithPath,
	capture,
	commands,
	failNext,
	fixtureState,
	mountPullRequests,
	openPull,
	openPullMergeMenu,
	REPOSITORY,
	waitForCall,
	waitForCommand,
} from "./pull-requests-companion-proof.helpers.ts";

test("GitHub sign-in and issue/PR detail buttons hand URLs to the trusted host", async ({
	page,
}) => {
	const issueView = await mountPullRequests(page, "issues");
	await issueView.getByRole("button", { name: "Open on GitHub" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual([`https://${"github.com"}/${REPOSITORY}/issues/701`]);
	await expect(page).toHaveURL(/pull-requests-companion-proof\.html/);

	const pullView = await mountPullRequests(page, "pulls");
	await pullView.getByRole("button", { name: "Open on GitHub" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual([`https://${"github.com"}/${REPOSITORY}/pull/101`]);
	await capture(pullView, "pull-requests-companion-external-open-success.png");

	const setup = await mountPullRequests(page, "issues", false);
	await setup.getByRole("button", { name: "Sign in with GitHub" }).click();
	await expect(
		setup.getByRole("button", { name: "Copy one-time GitHub code" })
	).toContainText("ABCD-EFGH");
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual(["https://github.com/login/device"]);
	await setup.getByRole("button", { name: "Open GitHub" }).click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual([
			"https://github.com/login/device",
			"https://github.com/login/device",
		]);
	await expect(
		setup.getByText(/Capability not granted: ui\.displayMode/)
	).toHaveCount(0);
	await setup.getByRole("button", { name: "Cancel" }).click();
	await expect(setup.getByText("Sign-in cancelled.")).toBeVisible();
	const cancelledDeviceFlow = await waitForCall(page, "DELETE", "/auth/device");
	expect(cancelledDeviceFlow.status).toBe(200);
});

test("trusted issue, task, and subtask links open through the host without popups", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	const hostUrl = page.url();
	const externalLinks = [
		{
			href: `https://github.com/${REPOSITORY}/issues/701`,
			link: companion.getByRole("link", {
				name: /Duplicate checkout jobs charge twice/,
			}),
		},
		{
			href: `https://github.com/${REPOSITORY}/issues/701`,
			link: companion.getByRole("link", {
				name: /Persist the idempotency key/,
			}),
		},
		{
			href: `https://github.com/${REPOSITORY}/issues/702`,
			link: companion.getByRole("link", {
				name: /octo\/ryu#702 Write retry telemetry/,
			}),
		},
	];
	const expectedDestinations: string[] = [];
	for (const { href, link } of externalLinks) {
		await expect(link).toHaveAttribute("href", href);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", /noopener/);
		await link.click();
		expectedDestinations.push(href);
		await expect
			.poll(() =>
				page.evaluate(() => window.__pullRequestsProof.openedExternal())
			)
			.toEqual(expectedDestinations);
		expect(page.context().pages()).toHaveLength(1);
		await expect(page).toHaveURL(hostUrl);
	}

	await companion.locator("body").evaluate(() => {
		const unsafeJavaScript = document.createElement("a");
		unsafeJavaScript.href = "javascript:window.__unsafeNavigationRan=true";
		unsafeJavaScript.target = "_blank";
		unsafeJavaScript.textContent = "Unsafe JavaScript destination";
		unsafeJavaScript.style.cssText =
			"position:fixed;top:0;left:0;z-index:99999;background:white;color:black;padding:8px";
		unsafeJavaScript.dataset.testid = "proof-unsafe-javascript";
		document.body.append(unsafeJavaScript);
		const unsafeFile = document.createElement("a");
		unsafeFile.href = "file:///etc/passwd";
		unsafeFile.target = "_blank";
		unsafeFile.textContent = "Unsafe file destination";
		unsafeFile.style.cssText = unsafeJavaScript.style.cssText;
		unsafeFile.style.top = "40px";
		unsafeFile.dataset.testid = "proof-unsafe-file";
		document.body.append(unsafeFile);
	});
	for (const scheme of ["javascript", "file"] as const) {
		await companion.getByTestId(`proof-unsafe-${scheme}`).click();
	}
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual(expectedDestinations);
	const unsafeNavigationRan = await companion.locator("body").evaluate(
		() =>
			// SAFETY: This controlled proof only authors the optional marker through its javascript: link assigning literal true; an unexecuted destination leaves the property absent.
			(window as Window & { __unsafeNavigationRan?: boolean })
				.__unsafeNavigationRan ?? false
	);
	expect(unsafeNavigationRan).toBe(false);
	await companion.locator("body").evaluate(() => {
		const syntheticLink = document.createElement("a");
		syntheticLink.href = "https://github.com/octo/ryu/issues/999";
		syntheticLink.target = "_blank";
		document.body.append(syntheticLink);
		syntheticLink.click();
		syntheticLink.remove();
	});
	await expect
		.poll(() =>
			page.evaluate(() => window.__pullRequestsProof.openedExternal())
		)
		.toEqual(expectedDestinations);
	await expect(page).toHaveURL(hostUrl);
	expect(page.context().pages()).toHaveLength(1);
	await companion
		.locator('[data-testid^="proof-unsafe-"]')
		.evaluateAll((links) => links.forEach((link) => link.remove()));
	await capture(
		companion,
		"pull-requests-companion-anchor-external-open-success.png"
	);
});

test("review comments and decisions preserve exact intent, retry failures, and mark drafts ready", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	// The review rail shows the readable decision for the selected pull request.
	const reviewDecision = (decision: string) =>
		companion
			.getByRole("complementary", { name: "Pull request review panel" })
			.getByText(decision, { exact: true });
	// Let the detail's eager diff read finish before arming the fixture failure,
	// so the two fake gh processes do not race on the shared fixture state.
	await waitForCall(page, "GET", "/pulls/octo/ryu/101/diff");
	const reviewComment = "Please keep the same idempotency key across retries.";
	const commentBox = companion.getByRole("textbox", { name: "Review comment" });
	await commentBox.fill(reviewComment);
	await failNext(
		page,
		"pr comment 101",
		"Fixture rejected the first PR comment."
	);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(companion.getByRole("alert")).toHaveText(
		"Fixture rejected the first PR comment."
	);
	await expect(commentBox).toHaveValue(reviewComment);
	const failedComment = await waitForCommand(page, "pr comment 101", true);
	expect(failedComment.argv).toEqual([
		"pr",
		"comment",
		"101",
		"--repo",
		REPOSITORY,
		"--body",
		reviewComment,
	]);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(companion.getByText(reviewComment)).toBeVisible();
	await expect(commentBox).toHaveValue("");
	const successfulComment = await waitForCommand(page, "pr comment 101", false);
	expect(successfulComment.argv).toEqual(failedComment.argv);
	const commentCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/comment"
	);
	expect(commentCall.body).toEqual({ body: reviewComment });

	await companion
		.getByRole("combobox", { name: "Comment type" })
		.selectOption("approve");
	await expect(companion.getByRole("button", { name: "Send" })).toBeEnabled();
	const approvalNote = "Verified with the local regression fixture.";
	await commentBox.fill(approvalNote);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(reviewDecision("Approved")).toBeVisible();
	const approvalCommand = await waitForCommand(
		page,
		"pr review 101 --repo octo/ryu --approve"
	);
	expect(approvalCommand.argv).toEqual([
		"pr",
		"review",
		"101",
		"--repo",
		REPOSITORY,
		"--approve",
		"--body",
		approvalNote,
	]);
	const approvalCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/review"
	);
	expect(approvalCall.body).toEqual({ action: "approve", body: approvalNote });

	await companion
		.getByRole("combobox", { name: "Comment type" })
		.selectOption("request_changes");
	const changesNote =
		"Please cover the timeout after the first charge succeeds.";
	await commentBox.fill(changesNote);
	await companion.getByRole("button", { name: "Send" }).click();
	await expect(reviewDecision("Changes requested")).toBeVisible();
	const changesCommand = await waitForCommand(
		page,
		"pr review 101 --repo octo/ryu --request-changes"
	);
	expect(changesCommand.argv).toEqual([
		"pr",
		"review",
		"101",
		"--repo",
		REPOSITORY,
		"--request-changes",
		"--body",
		changesNote,
	]);
	const changesCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/review"
	);
	expect(changesCall.body).toEqual({
		action: "request_changes",
		body: changesNote,
	});

	await openPull(companion, 102);
	await expect(
		companion.getByRole("button", { name: "Ready for review" })
	).toBeVisible();
	await companion.getByRole("button", { name: "Ready for review" }).click();
	await expect(
		companion.getByRole("button", { name: "Ready for review" })
	).toHaveCount(0);
	const readyCommand = await waitForCommand(
		page,
		"pr ready 102 --repo octo/ryu"
	);
	expect(readyCommand.argv).toEqual([
		"pr",
		"ready",
		"102",
		"--repo",
		REPOSITORY,
	]);
	const readyCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/102/ready"
	);
	expect(readyCall.body).toEqual({ draft: false });
	expect(
		(await fixtureState(page)).pullDetails[`${REPOSITORY}#102`]?.isDraft
	).toBe(false);
	await expect(
		companion.getByRole("heading", { name: /Rotate session cookie/ })
	).toBeVisible();
	await expect(reviewDecision("Review required")).toBeVisible();
	await capture(companion, "pull-requests-companion-review-ready-state.png");
});

test("stack dialogs validate unique layers, save order, navigate layers, and unstack safely", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	const createButton = companion.getByRole("button", { name: "Create stack" });
	await expect(createButton).toBeVisible();
	await createButton.click();
	let dialog = companion.getByRole("dialog");
	const numbers = dialog.getByRole("textbox", { name: "Pull request numbers" });
	await expect(numbers).toHaveValue("101");
	await numbers.fill("101, 102, 102");
	await dialog.getByRole("button", { name: "Create a stack" }).click();
	await expect(
		dialog.getByText(/at least two unique PR numbers/)
	).toBeVisible();
	const noStackWrite = await commands(page);
	expect(
		noStackWrite.some((command) =>
			command.argv.includes("repos/octo/ryu/stacks")
		)
	).toBe(false);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	await companion.getByRole("button", { name: "Create stack" }).click();
	dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("101, 102");
	await dialog.getByRole("button", { name: "Create a stack" }).click();
	await expect(
		companion.getByRole("heading", { name: "Stack #900" })
	).toBeVisible();
	const createCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/stack"
	);
	expect(createCall.body).toEqual({ pullRequests: [101, 102] });
	const createCommand = await waitForCommand(
		page,
		"repos/octo/ryu/stacks --header"
	);
	expect(createCommand.argv).toContain("pull_requests[]=101");
	expect(createCommand.argv).toContain("pull_requests[]=102");
	const currentLayer = companion.getByRole("button", {
		name: /#101 Protect billing retries/,
	});
	await expect(currentLayer).toBeDisabled();
	await expect(
		companion.getByRole("button", { name: /#102 Rotate session cookie/ })
	).toBeEnabled();

	await companion.getByRole("button", { name: "Add layer" }).click();
	dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("103");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	expect(
		await callsWithPath(page, "POST", "/pulls/octo/ryu/101/stack/add")
	).toHaveLength(0);
	await companion.getByRole("button", { name: "Add layer" }).click();
	dialog = companion.getByRole("dialog");
	await dialog
		.getByRole("textbox", { name: "Pull request numbers" })
		.fill("103");
	await dialog.getByRole("button", { name: "Add layers" }).click();
	await expect(
		companion.getByRole("button", { name: /#103 Expose usage export/ })
	).toBeVisible();
	const addCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/101/stack/add"
	);
	expect(addCall.body).toEqual({ pullRequests: [103], stackNumber: 900 });
	const addCommand = await waitForCommand(
		page,
		"repos/octo/ryu/stacks/900/add --header"
	);
	expect(addCommand.argv).toContain("pull_requests[]=103");

	await companion
		.getByRole("button", { name: /#102 Rotate session cookie/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: /Rotate session cookie/ })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: "Stack #900" })
	).toBeVisible();
	await companion.getByRole("button", { name: "Unstack" }).click();
	dialog = companion.getByRole("dialog");
	await expect(dialog.getByText(/removes only unmerged layers/)).toBeVisible();
	await dialog.getByRole("button", { name: "Unstack" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		companion.getByRole("heading", { name: "Stack", exact: true })
	).toBeVisible();
	const unstackCall = await waitForCall(
		page,
		"POST",
		"/pulls/octo/ryu/102/stack/unstack"
	);
	expect(unstackCall.body).toEqual({ stackNumber: 900 });
	const unstackCommand = await waitForCommand(
		page,
		"repos/octo/ryu/stacks/900/unstack --header"
	);
	expect(unstackCommand.argv).toContain("--method");
	await capture(companion, "pull-requests-companion-stack-unstacked.png");
});

test("all direct merge methods and auto-merge send exact choices and update pull state", async ({
	page,
}) => {
	const companion = await mountPullRequests(page, "pulls");
	const cases = [
		{
			number: 101,
			label: "Create merge commit",
			strategy: "merge",
			action: "default",
			auto: false,
			flag: "--merge",
		},
		{
			number: 102,
			label: "Squash and merge",
			strategy: "squash",
			action: "default",
			auto: false,
			flag: "--squash",
		},
		{
			number: 103,
			label: "Rebase and merge",
			strategy: "rebase",
			action: "default",
			auto: false,
			flag: "--rebase",
		},
		{
			number: 106,
			label: "Auto-merge when ready",
			strategy: "squash",
			action: "merge_queue",
			auto: true,
			flag: "--squash --auto",
		},
	] as const;
	for (const item of cases) {
		await openPull(companion, item.number);
		await openPullMergeMenu(companion);
		await companion.getByRole("menuitem", { name: item.label }).click();
		const pathName = `/pulls/${REPOSITORY.split("/").join("/")}/${item.number}/merge`;
		const mergeCall = await waitForCall(page, "POST", pathName);
		expect(mergeCall.body).toEqual({
			auto: item.auto,
			mergeAction: item.action,
			strategy: item.strategy,
		});
		const mergeCommand = await waitForCommand(
			page,
			`pr merge ${item.number} --repo ${REPOSITORY} ${item.flag}`
		);
		expect(mergeCommand.argv).toEqual([
			"pr",
			"merge",
			String(item.number),
			"--repo",
			REPOSITORY,
			...(item.strategy === "merge"
				? ["--merge"]
				: item.strategy === "rebase"
					? ["--rebase"]
					: ["--squash"]),
			...(item.auto ? ["--auto"] : []),
		]);
		await expect
			.poll(
				async () =>
					(await fixtureState(page)).pullDetails[`${REPOSITORY}#${item.number}`]
						?.state
			)
			.toBe("MERGED");
	}
	await capture(companion, "pull-requests-companion-merge-methods.png");
});

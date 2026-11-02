import { access } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
	draftBody,
	imageDescription,
	localDateTimeValue,
	openingText,
	proofState,
	readAccounts,
	readDrafts,
	readMedia,
	readPosts,
	saveScreenshot,
	seedFixtureSchema,
	tailText,
	timingResponseSchema,
	variantText,
	waitForTransientAlerts,
	writeCalls,
} from "./social-compose-children-proof.helpers.ts";

test("compose children produce real draft, media, variant, target, and timing outcomes", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();
	await expect(page.getByText("No accounts yet.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Connect an account" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Schedule", exact: true })
	).toBeDisabled();
	await saveScreenshot(page, "social-compose-children-empty-targets.png");
	const writesBeforeConnect = writeCalls((await proofState(page)).calls);
	await page.getByRole("button", { name: "Connect an account" }).click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	expect(writeCalls((await proofState(page)).calls)).toEqual(
		writesBeforeConnect
	);

	const seedResponse = await page.request.post("/__proof/seed");
	expect(seedResponse.ok()).toBe(true);
	const fixture = seedFixtureSchema.parse(await seedResponse.json());
	await page.goto("/?section=compose");
	await expect(page.getByRole("heading", { name: "Compose" })).toBeVisible();

	const accounts = await readAccounts(page);
	expect(accounts.accounts).toHaveLength(2);
	expect(accounts.accounts.every((account) => !account.connected)).toBe(true);
	const bluesky = accounts.accounts.find(
		(account) => account.platform === "bluesky"
	);
	const linkedin = accounts.accounts.find(
		(account) => account.platform === "linkedin"
	);
	expect(bluesky).toBeDefined();
	expect(linkedin).toBeDefined();
	const targetIds = accounts.accounts.map((account) => account.id);
	const blueskyTarget = page.getByRole("checkbox", {
		name: "@children-bluesky",
	});
	const linkedinTarget = page.getByRole("checkbox", {
		name: "@children-linkedin",
	});
	await page.getByRole("button", { name: "Select all", exact: true }).click();
	await expect(blueskyTarget).toBeChecked();
	await expect(linkedinTarget).toBeChecked();
	await expect(page.locator("article")).toHaveCount(2);
	await page.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(blueskyTarget).not.toBeChecked();
	await expect(linkedinTarget).not.toBeChecked();
	await expect(
		page.getByText("Pick a target account to preview the post.")
	).toBeVisible();
	await linkedinTarget.click();
	await expect(linkedinTarget).toBeChecked();
	await blueskyTarget.click();
	await expect(blueskyTarget).toBeChecked();
	await expect(page.locator("article")).toHaveCount(2);

	const postText = page.getByRole("textbox", { name: "Post text" });
	const runButtons = page.getByRole("button", { name: "Run", exact: true });
	await expect(runButtons).toHaveCount(3);
	await expect(runButtons.nth(0)).toBeDisabled();
	await expect(runButtons.nth(1)).toBeDisabled();
	await expect(runButtons.nth(2)).toBeDisabled();
	await postText.fill(openingText);
	await expect(runButtons.first()).toBeEnabled();
	expect((await proofState(page)).modelCalls).toHaveLength(0);

	const hashtagRun = runButtons.nth(0);
	await hashtagRun.click();
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture model temporarily unavailable." })
	).toBeVisible();
	await hashtagRun.click();
	await expect(
		page.getByRole("button", { name: "#Launch", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "#Launch", exact: true }).click();
	await expect(postText).toHaveValue(`${openingText} #Launch`);
	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "#Proof", exact: true })
	).toHaveCount(0);
	await expect(postText).toHaveValue(`${openingText} #Launch`);

	const reformatPlatform = page.getByLabel("Platform to rewrite for", {
		exact: true,
	});
	await reformatPlatform.selectOption("linkedin");
	await runButtons.nth(1).click();
	await expect(page.getByText(variantText, { exact: true })).toBeVisible();
	await expect(page.getByText("Custom variant", { exact: true })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Apply to LinkedIn" }).click();
	await expect(page.getByText("Applied variants:")).toBeVisible();
	await expect(page.getByText("Custom variant", { exact: true })).toBeVisible();
	const linkedinPreview = page
		.locator("article")
		.filter({ hasText: "@children-linkedin" });
	await expect(linkedinPreview).toContainText(variantText);
	await page.getByRole("button", { name: "LinkedIn ✕", exact: true }).click();
	await expect(page.getByText("Applied variants:")).toHaveCount(0);
	await expect(linkedinPreview).toContainText(`${openingText} #Launch`);
	await runButtons.nth(1).click();
	await expect(page.getByText(variantText, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Apply to LinkedIn" }).click();
	await expect(linkedinPreview).toContainText(variantText);

	await runButtons.nth(2).click();
	await expect(page.getByText("91", { exact: true })).toBeVisible();
	await expect(
		page.getByText("The opening line is clear and specific.", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(page.getByText("91", { exact: true })).toHaveCount(0);
	await expect(postText).toHaveValue(`${openingText} #Launch`);
	const aiState = await proofState(page);
	expect(aiState.modelCalls).toHaveLength(5);
	expect(aiState.modelCalls[0]?.prompt).toContain(
		"Suggest up to 8 relevant hashtags"
	);
	expect(aiState.modelCalls[1]?.prompt).toContain(
		"Suggest up to 8 relevant hashtags"
	);
	expect(aiState.modelCalls[2]?.prompt).toContain("natively on LinkedIn");
	expect(aiState.modelCalls[2]?.prompt).toContain("#Launch");
	expect(aiState.modelCalls[4]?.prompt).toContain(
		"Rate how strong the opening hook"
	);

	await postText.press("Home");
	for (const _ of Array.from({ length: 5 })) {
		await postText.press("ArrowRight");
	}
	await page
		.getByRole("button", { name: "Split segment 1 at the cursor" })
		.click();
	await expect(
		page.getByRole("textbox", { name: "Segment 1 text" })
	).toHaveValue("Alpha");
	await expect(
		page.getByRole("textbox", { name: "Segment 2 text" })
	).toHaveValue("beta launches. #Launch");
	await page.getByRole("button", { name: "Add segment", exact: true }).click();
	await page.getByRole("textbox", { name: "Segment 3 text" }).fill(tailText);
	await page.getByRole("button", { name: "Move segment 3 up" }).click();
	await expect(
		page.getByRole("textbox", { name: "Segment 2 text" })
	).toHaveValue(tailText);
	await page.getByRole("button", { name: "Move segment 2 down" }).click();
	await expect(
		page.getByRole("textbox", { name: "Segment 2 text" })
	).toHaveValue("beta launches. #Launch");
	await page.getByRole("button", { name: "Remove segment 2" }).click();
	await expect(
		page.getByRole("textbox", { name: "Segment 1 text" })
	).toHaveValue("Alpha");
	await expect(
		page.getByRole("textbox", { name: "Segment 2 text" })
	).toHaveValue(tailText);

	const firstMediaPathInput = page
		.getByRole("textbox", {
			name: "Media file path or URL",
		})
		.first();
	await firstMediaPathInput.fill(fixture.media.enterPath);
	await firstMediaPathInput.press("Enter");
	await expect(
		page.getByText("direct-enter.png", { exact: true })
	).toBeVisible();
	await firstMediaPathInput.fill(fixture.media.attachPath);
	await page
		.getByRole("button", { name: "Attach", exact: true })
		.first()
		.click();
	await expect(
		page.getByText("direct-attach.png", { exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Library", exact: true })
		.first()
		.click();
	const libraryDialog = page.getByRole("dialog");
	await expect(
		libraryDialog.getByRole("heading", { name: "Media library" })
	).toBeVisible();
	await expect(libraryDialog).toContainText(
		"Files registered in this workspace. Outpost stores the path, never a copy"
	);
	await waitForTransientAlerts(page);
	await saveScreenshot(page, "social-compose-children-library-dialog.png");
	await page.keyboard.press("Escape");
	await expect(libraryDialog).toBeHidden();
	await expect(
		page.getByText("direct-enter.png", { exact: true })
	).toBeVisible();

	await page
		.getByRole("button", { name: "Library", exact: true })
		.first()
		.click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: /library-seed\.png/ })
		.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(
		page.getByText("library-seed.png", { exact: true })
	).toBeVisible();
	await expect(page.getByText("3 / 4 media", { exact: true })).toHaveCount(1);

	await page
		.getByRole("button", { name: "Remove direct-enter.png", exact: true })
		.click();
	await expect(page.getByText("direct-enter.png", { exact: true })).toHaveCount(
		0
	);
	await expect(page.getByText("2 / 4 media", { exact: true })).toHaveCount(1);
	const descriptionInput = page.getByRole("textbox", {
		name: "Describe library-seed.png for screen readers",
	});
	const addDescription = page
		.getByRole("button", {
			name: "Add to post",
			exact: true,
		})
		.last();
	await expect(addDescription).toBeDisabled();
	await descriptionInput.fill(imageDescription);
	await expect(addDescription).toBeEnabled();
	await addDescription.click();
	await expect(descriptionInput).toHaveValue("");
	await expect(
		page.getByRole("textbox", { name: "Segment 1 text" })
	).toHaveValue(`Alpha\n\nImage description: ${imageDescription}`);
	await expect(addDescription).toBeDisabled();
	expect((await readMedia(page)).media).toHaveLength(1);
	await access(fixture.media.enterPath);
	await access(fixture.media.attachPath);
	await access(fixture.media.libraryPath);
	await waitForTransientAlerts(page);
	await saveScreenshot(page, "social-compose-children-media-and-segments.png");

	const platformFilter = page.getByLabel("Platform to rank times for", {
		exact: true,
	});
	await platformFilter.selectOption("linkedin");
	const suggestTime = page.getByRole("button", {
		name: "Suggest a time",
		exact: true,
	});
	await suggestTime.click();
	await expect(
		page.getByRole("alert").filter({
			hasText: "Fixture could not load posting times on the first request.",
		})
	).toBeVisible();
	await suggestTime.click();
	await expect(
		page.getByText("Not enough history yet", { exact: false })
	).toBeVisible();
	const afterTimingRetry = await proofState(page);
	const timingCalls = afterTimingRetry.calls.filter((call) =>
		call.path.startsWith("/best-times")
	);
	expect(timingCalls).toHaveLength(2);
	expect(timingCalls[0]).toEqual({
		method: "GET",
		path: "/best-times?workspace_id=default&platform=linkedin",
	});
	expect(timingCalls[1]).toEqual(timingCalls[0]);
	const timingCaptured = afterTimingRetry.responses
		.filter((response) => response.path.startsWith("/best-times"))
		.at(-1)?.value;
	const timingResponse =
		timingCaptured === undefined
			? undefined
			: timingResponseSchema.parse(timingCaptured);
	expect(timingResponse?.best_times.basis).toBe("defaults");
	expect(timingResponse?.best_times.sample_size).toBe(0);
	expect(timingResponse?.best_times.slots.length).toBeGreaterThan(0);
	const recommendedAt = timingResponse?.best_times.slots[0]?.next_occurrence;
	expect(recommendedAt).toBeDefined();
	await waitForTransientAlerts(page);
	await saveScreenshot(
		page,
		"social-compose-children-timing-recommendation.png"
	);
	await page.getByRole("button", { name: "Use", exact: true }).first().click();
	const scheduleInput = page.getByLabel("Schedule for", { exact: true });
	await expect(scheduleInput).toHaveValue(
		await localDateTimeValue(page, recommendedAt ?? 0)
	);

	const scheduleButton = page.getByRole("button", {
		name: "Schedule",
		exact: true,
	});
	await expect(scheduleButton).toBeEnabled();
	await scheduleButton.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Scheduled" }).last()
	).toContainText("Scheduled");

	const expectedSegments = [
		{
			media: [
				{
					mime_type: "image/png",
					name: "direct-attach.png",
					path: fixture.media.attachPath,
				},
				{
					mime_type: "image/png",
					name: "library-seed.png",
					path: fixture.media.libraryAsset.path,
				},
			],
			text: `Alpha\n\nImage description: ${imageDescription}`,
		},
		{ media: [], text: tailText },
	];
	const expectedBody = draftBody(expectedSegments, targetIds);
	const drafts = await readDrafts(page);
	expect(drafts.drafts).toHaveLength(1);
	const savedDraft = drafts.drafts[0];
	expect(savedDraft.body).toEqual(expectedBody);
	const posts = await readPosts(page);
	expect(posts.posts).toHaveLength(1);
	const post = posts.posts[0];
	expect(post.status).toBe("scheduled");
	expect(post.draft_id).toBe(savedDraft.id);
	expect(post.scheduled_for).toBe(recommendedAt);
	expect(post.targets.map((target) => target.social_account_id)).toEqual(
		targetIds
	);

	const linkedInId = linkedin?.id;
	expect(linkedInId).toBeDefined();
	const expectedVariant = draftBody(
		[{ ...expectedSegments[0]!, text: variantText }, expectedSegments[1]!],
		[linkedInId ?? ""]
	);
	const postCalls = (await proofState(page)).calls.filter(
		(call) => call.path === "/posts" && call.method === "POST"
	);
	expect(postCalls).toHaveLength(1);
	expect(postCalls[0]?.body).toEqual({
		account_ids: targetIds,
		draft_id: savedDraft.id,
		scheduled_for: recommendedAt,
		variants: { [linkedInId ?? ""]: expectedVariant },
		workspace_id: "default",
	});
	const settingsResponse = await page.request.get(
		"/__social/settings?workspace_id=default"
	);
	expect(settingsResponse.ok()).toBe(true);
	const settings = await settingsResponse.json();
	expect(settings.settings.scheduler_enabled).toBe(false);
	expect((await readMedia(page)).media).toHaveLength(1);
	await expect(
		page.getByRole("button", { name: "Remove segment 1" })
	).toBeDisabled();
	await saveScreenshot(page, "social-compose-children-scheduled.png");

	await page.goto("/?section=queue");
	await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
	await expect(page.getByText("Pending", { exact: true })).toHaveCount(2);
	await expect(page.getByText("Scheduled", { exact: true })).toHaveCount(2);
	await saveScreenshot(page, "social-compose-children-queue.png");
});

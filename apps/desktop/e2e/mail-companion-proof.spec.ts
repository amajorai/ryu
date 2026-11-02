import { expect, test } from "@playwright/test";
import {
	calls,
	capture,
	mountMail,
	state,
	waitForCall,
} from "./mail-companion-proof.helpers.ts";

test("initial inbox load retries after a local failure and selecting another inbox clears the prior message", async ({
	page,
}) => {
	const companion = await mountMail(page, {
		failure: {
			message: "Fixture mail list is temporarily unavailable.",
			method: "mail.list",
		},
	});
	await expect(companion.getByRole("alert")).toContainText(
		"Unable to load mail"
	);
	const listCallsBeforeRetry = (await calls(page)).filter(
		(call) => call.method === "mail.list"
	).length;
	await companion.getByRole("button", { name: "Retry" }).click();
	await expect(companion.getByRole("alert")).toHaveCount(0);
	await expect(
		companion.getByRole("heading", { name: "Ticket 42: sign-in help" })
	).toBeVisible();
	const retryCall = await waitForCall(
		page,
		"mail.list",
		undefined,
		listCallsBeforeRetry
	);
	expect(retryCall.status).toBe(200);
	expect(retryCall.args).toBeUndefined();

	await companion.getByText("Billing", { exact: true }).click();
	await expect(
		companion.getByRole("option", { name: /Billing inbox fixture/ })
	).toBeVisible();
	await expect(
		companion
			.getByRole("article")
			.getByRole("heading", { name: "Ticket 42: sign-in help", exact: true })
	).toHaveCount(0);
	await expect(companion.getByText("Support").first()).toBeVisible();
	expect(
		(await calls(page)).filter((call) => call.method === "mail.messages").at(-1)
			?.args
	).toEqual({ inboxId: "inbox-billing" });
	expect(
		(await state(page)).contacts.map((contact) => contact.email)
	).toContain("avery@example.test");
	await capture(companion, "mail-companion-inbox-selection.png");
	await companion
		.getByRole("option", { name: /Billing inbox fixture/ })
		.click();
	await expect(companion.getByRole("article").getByRole("heading")).toHaveText(
		"Billing inbox fixture"
	);
	await expect(companion.getByRole("article")).not.toContainText(
		"Ticket 42: sign-in help"
	);
});

test("create inbox validates locally, retries a failed create, reveals inbound details, rotates, deletes, and can be cancelled", async ({
	page,
}) => {
	const companion = await mountMail(page);
	await companion
		.getByRole("button", { name: "New inbox", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "New inbox" })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	expect(
		(await calls(page)).some((call) => call.method === "mail.create")
	).toBe(false);

	await dialog.getByPlaceholder("Support", { exact: true }).fill("Returns");
	await dialog
		.getByPlaceholder("support@your-domain.com", { exact: true })
		.fill("returns@agent.test");
	await page.evaluate(() => {
		window.__mailProof.failNext(
			"mail.create",
			"Local fixture rejected one create."
		);
	});
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	const failedCreate = await waitForCall(page, "mail.create");
	expect(failedCreate.status).toBe(503);
	await expect(dialog.getByPlaceholder("Support", { exact: true })).toHaveValue(
		"Returns"
	);
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(
		dialog.getByRole("heading", { name: "Inbox created" })
	).toBeVisible();
	await expect(dialog.getByText("fixture-secret-new-inbox")).toBeVisible();
	await expect(
		dialog.getByText(
			"https://mail.example.test/api/mail/inbound/inbox-created-3"
		)
	).toBeVisible();
	const createdCall = (await calls(page))
		.filter((call) => call.method === "mail.create")
		.at(-1);
	expect(createdCall?.args).toEqual({
		address: "returns@agent.test",
		name: "Returns",
	});
	const inboundCall = await waitForCall(page, "mail.inboundUrl");
	expect(inboundCall.args).toEqual({ inboxId: "inbox-created-3" });
	await dialog
		.getByRole("button", { name: "Rotate secret", exact: true })
		.click();
	await expect(
		dialog.getByText("fixture-secret-rotated-inbox-created-3")
	).toBeVisible();
	expect(
		(await calls(page))
			.filter((call) => call.method === "mail.rotateSecret")
			.at(-1)?.args
	).toEqual({
		id: "inbox-created-3",
	});
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect((await state(page)).inboxes.map((inbox) => inbox.id)).not.toContain(
		"inbox-created-3"
	);
	expect(
		(await calls(page)).filter((call) => call.method === "mail.delete").at(-1)
			?.args
	).toEqual({
		id: "inbox-created-3",
	});

	await companion
		.getByRole("button", { name: "Create inbox", exact: true })
		.click();
	const secondDialog = companion.getByRole("dialog");
	await secondDialog
		.getByPlaceholder("Support", { exact: true })
		.fill("Returns archive");
	await secondDialog
		.getByPlaceholder("support@your-domain.com", { exact: true })
		.fill("returns-archive@agent.test");
	await secondDialog
		.getByRole("button", { name: "Create", exact: true })
		.click();
	await expect(
		secondDialog.getByRole("heading", { name: "Inbox created" })
	).toBeVisible();
	await secondDialog.getByRole("button", { name: "Done", exact: true }).click();
	await expect(secondDialog).toBeHidden();
	await companion
		.getByRole("button", { name: "Create inbox", exact: true })
		.click();
	await companion
		.getByRole("dialog")
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(companion.getByRole("dialog")).toBeHidden();
});

test("the empty state can create an inbox and reappears after the only inbox is deleted", async ({
	page,
}) => {
	const companion = await mountMail(page, { emptyInboxes: true });
	await expect(
		companion.getByRole("heading", { name: "No inboxes yet" })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Create inbox", exact: true })
		.last()
		.click();
	const dialog = companion.getByRole("dialog");
	await dialog.getByPlaceholder("Support", { exact: true }).fill("First inbox");
	await dialog
		.getByPlaceholder("support@your-domain.com", { exact: true })
		.fill("first@agent.test");
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(
		dialog.getByRole("heading", { name: "Inbox created" })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		companion.getByRole("heading", { name: "No inboxes yet" })
	).toBeVisible();
	await capture(companion, "mail-companion-empty-inbox-state.png");
});

test("created inboxes remain visible after remounting the production app bundle", async ({
	page,
}) => {
	const companion = await mountMail(page);
	await companion
		.getByRole("button", { name: "New inbox", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByPlaceholder("Support", { exact: true })
		.fill("Reload proof");
	await dialog
		.getByPlaceholder("support@your-domain.com", { exact: true })
		.fill("reload@agent.test");
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(
		dialog.getByRole("heading", { name: "Inbox created" })
	).toBeVisible();
	await capture(companion, "mail-companion-inbox-created-details.png");
	await dialog.getByRole("button", { name: "Done", exact: true }).click();
	await page.reload();
	const reloaded = await mountMail(page);
	await expect(
		reloaded.getByRole("option", { name: /Reload proof reload@agent.test/ })
	).toBeVisible();
	expect(
		(await state(page)).inboxes.some(
			(inbox) => inbox.address === "reload@agent.test"
		)
	).toBe(true);
	await capture(reloaded, "mail-companion-inbox-survives-remount.png");
});

test("messages search and unread filters show real fixture rows, thread and sidebar navigation change panels", async ({
	page,
}) => {
	const companion = await mountMail(page);
	const search = companion.getByRole("textbox", { name: "Search messages" });
	const messageList = companion.getByRole("listbox", { name: "Messages" });
	await expect(
		messageList.getByRole("option", { name: /Ticket 42: sign-in help/ })
	).toBeVisible();
	await search.fill("billing");
	await expect(
		messageList.getByRole("option", { name: /Invoice question/ })
	).toBeVisible();
	await expect(
		messageList.getByRole("option", { name: /Ticket 42: sign-in help/ })
	).toHaveCount(0);
	await search.fill("nothing-matches-this");
	await expect(
		companion.getByRole("heading", { name: "No matches" })
	).toBeVisible();
	await search.fill("");
	await companion.getByRole("button", { name: "Unread" }).click();
	await expect(
		messageList.getByRole("option", { name: /Ticket 42: sign-in help/ })
	).toBeVisible();
	await expect(
		messageList.getByRole("option", { name: /Invoice question/ })
	).toHaveCount(0);
	await companion.getByRole("button", { name: "All mail" }).click();
	await companion.getByRole("tab", { name: "Threads" }).click();
	await expect(
		companion.getByRole("heading", { name: "Threads" })
	).toBeVisible();
	await expect(
		companion.getByRole("option", { name: /Ticket 42 thread/ })
	).toBeVisible();
	await expect(companion.getByRole("button", { name: "Reply" })).toHaveCount(0);
	await companion.getByRole("tab", { name: "Drafts" }).click();
	await expect(
		companion.getByRole("heading", { name: "Drafts" })
	).toBeVisible();
	await expect(companion.getByText("Fixture follow-up")).toBeVisible();
	await companion.getByRole("tab", { name: "Webhooks" }).click();
	await expect(
		companion.getByRole("heading", { name: "Webhooks" })
	).toBeVisible();
	await expect(
		companion.getByText("https://hooks.example.test/mail-events")
	).toBeVisible();
	await companion.getByRole("tab", { name: "Messages" }).click();
	await expect(
		companion.getByRole("heading", { name: "Inbox", exact: true })
	).toBeVisible();
	await capture(companion, "mail-companion-search-filter-threads.png");
});

test("opening a message loads a local attachment URL and both refresh controls requery the fixture", async ({
	page,
}) => {
	const companion = await mountMail(page);
	await companion
		.getByRole("option", { name: /Ticket 42: sign-in help/ })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Ticket 42: sign-in help" })
	).toBeVisible();
	await expect(
		companion.getByText("Hello, I cannot sign in to my local test account.")
	).toBeVisible();
	await companion.getByRole("button", { name: "Open", exact: true }).click();
	const attachmentCall = await waitForCall(
		page,
		"mail.request:GET:/api/mail/attachments/attachment-ticket",
		"/api/mail/attachments/attachment-ticket"
	);
	expect(attachmentCall.status).toBe(200);
	const downloadLink = companion.getByRole("link", { name: "Download" });
	await expect(downloadLink).toHaveAttribute(
		"href",
		/\/__mail-proof\/download\/attachment-ticket$/
	);
	await expect(downloadLink).toHaveAttribute("target", "_blank");

	const beforeDetailRefresh = (await calls(page)).length;
	await companion.getByRole("button", { name: "Refresh", exact: true }).click();
	await waitForCall(page, "mail.messages", undefined, 1);
	await expect
		.poll(async () => (await calls(page)).length)
		.toBeGreaterThan(beforeDetailRefresh);
	const beforeListRefresh = (await calls(page)).length;
	await companion.getByRole("button", { name: "Refresh messages" }).click();
	await expect
		.poll(async () => (await calls(page)).length)
		.toBeGreaterThan(beforeListRefresh);
	expect(
		(await calls(page)).filter((call) => call.method === "mail.messages").length
	).toBeGreaterThanOrEqual(3);
	await capture(companion, "mail-companion-message-attachment.png");
	await companion.getByRole("button", { name: "More message actions" }).click();
	await capture(companion, "mail-companion-more-actions-inert.png");
});

test("reply preserves the draft after a local failure and sends the retry", async ({
	page,
}) => {
	const companion = await mountMail(page);
	await companion
		.getByRole("option", { name: /Ticket 42: sign-in help/ })
		.click();
	await companion.getByRole("button", { name: "Reply", exact: true }).click();
	await expect(
		companion.getByRole("heading", { name: "New message" })
	).toBeVisible();
	const to = companion.getByPlaceholder("recipient@example.com");
	const subject = companion.getByPlaceholder("Subject", { exact: true });
	const body = companion.getByPlaceholder("Write your message…", {
		exact: true,
	});
	await expect(to).toHaveValue("avery@example.test");
	await expect(subject).toHaveValue("Re: Ticket 42: sign-in help");
	await body.fill("The local account sign-in issue is fixed.");
	await page.evaluate(() => {
		window.__mailProof.failNext(
			"mail.send",
			"Local mail transport rejected this attempt."
		);
	});
	await companion.getByRole("button", { name: "Send", exact: true }).click();
	const failedSend = await waitForCall(page, "mail.send");
	expect(failedSend.status).toBe(503);
	await expect(to).toHaveValue("avery@example.test");
	await expect(body).toHaveValue("The local account sign-in issue is fixed.");
	await companion.getByRole("button", { name: "Send", exact: true }).click();
	const sent = await waitForCall(page, "mail.send", undefined, 1);
	expect(sent.status).toBe(202);
	expect(sent.args).toEqual({
		attachments: [],
		inReplyTo: "<ticket-42@example.test>",
		references: "<ticket-42@example.test>",
		subject: "Re: Ticket 42: sign-in help",
		to: ["avery@example.test"],
		text: "The local account sign-in issue is fixed.",
		trackOpens: false,
		inboxId: "inbox-support",
	});
	await expect(
		companion
			.getByRole("listbox", { name: "Messages" })
			.getByRole("option", { name: /Re: Ticket 42: sign-in help/ })
	).toBeVisible();
	expect(
		(await state(page)).messages.some(
			(message) => message.subject === "Re: Ticket 42: sign-in help"
		)
	).toBe(true);
	await capture(companion, "mail-companion-reply-send-retry.png");
});

test("compose saves exact scheduled draft fields and reload restores persisted local drafts", async ({
	page,
}) => {
	const companion = await mountMail(page);
	await companion.getByRole("button", { name: "Compose message" }).click();
	await companion
		.getByPlaceholder("recipient@example.com")
		.fill("avery@example.test");
	await companion
		.getByPlaceholder("Subject", { exact: true })
		.fill("Scheduled local follow-up");
	await companion
		.getByPlaceholder("Write your message…", { exact: true })
		.fill("Send after review.");
	await companion
		.getByPlaceholder("<p>Optional HTML</p>", { exact: true })
		.fill("<p>HTML remains local until the draft is sent.</p>");
	await companion.getByRole("checkbox", { name: /Track opens/ }).check();
	await companion.locator('input[type="file"]').setInputFiles({
		name: "draft-proof.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("local draft attachment"),
	});
	await expect(companion.getByText("1 attachment ready")).toBeVisible();
	await expect(
		companion.getByRole("checkbox", { name: /Track opens/ })
	).toBeChecked();
	await companion
		.locator('input[type="datetime-local"]')
		.fill("2026-09-29T08:15");
	await companion
		.getByRole("button", { name: "Save draft", exact: true })
		.click();
	const draftCall = await waitForCall(
		page,
		"mail.request:POST:/api/mail/inboxes/inbox-support/drafts",
		"/api/mail/inboxes/inbox-support/drafts"
	);
	// The Mail API takes an RFC 3339 instant, so the Companion sends the
	// browser's wall-clock input as the equivalent UTC time.
	const scheduledAt = await page.evaluate(() =>
		new Date("2026-09-29T08:15").toISOString()
	);
	expect(draftCall.args).toEqual({
		attachments: [
			{
				content: "bG9jYWwgZHJhZnQgYXR0YWNobWVudA==",
				content_type: "text/plain",
				filename: "draft-proof.txt",
			},
		],
		cc: [],
		html: "<p>HTML remains local until the draft is sent.</p>",
		sendAt: scheduledAt,
		send_at: scheduledAt,
		subject: "Scheduled local follow-up",
		text: "Send after review.",
		to: ["avery@example.test"],
	});
	const savedState = await state(page);
	expect(
		savedState.drafts.some(
			(draft) =>
				draft.subject === "Scheduled local follow-up" &&
				draft.status === "scheduled" &&
				draft.attachments[0]?.filename === "draft-proof.txt"
		)
	).toBe(true);
	await capture(companion, "mail-companion-draft-saved-before-reload.png");

	await page.reload();
	const reloaded = await mountMail(page);
	await reloaded.getByRole("tab", { name: "Drafts" }).click();
	await expect(
		reloaded.getByRole("option", { name: /Scheduled local follow-up/ })
	).toBeVisible();
	await expect(reloaded.getByRole("tab", { name: "Drafts" })).toContainText(
		"2"
	);

	await reloaded.getByRole("option", { name: /Fixture follow-up/ }).click();
	const sendDraftCall = await waitForCall(
		page,
		"mail.request:POST:/api/mail/inboxes/inbox-support/drafts/draft-follow-up/send",
		"/api/mail/inboxes/inbox-support/drafts/draft-follow-up/send"
	);
	expect(sendDraftCall.args).toBeUndefined();
	expect(sendDraftCall.status).toBe(202);
	const afterSend = await state(page);
	expect(afterSend.drafts.map((draft) => draft.id)).not.toContain(
		"draft-follow-up"
	);
	expect(
		afterSend.messages.some(
			(message) => message.subject === "Fixture follow-up"
		)
	).toBe(true);
	await capture(reloaded, "mail-companion-drafts-sent.png");
});

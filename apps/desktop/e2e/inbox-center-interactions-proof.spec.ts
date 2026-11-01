import { expect, test } from "@playwright/test";

import {
	assertNoUnhandledFixtureRoutes,
	capture,
	clearOpenedTabs,
	createInboxFixture,
	makeAnnouncement,
	makeApproval,
	makeNotification,
	makeQuest,
	mountInbox,
	NOW,
	openedTabs,
	rowFor,
} from "./inbox-center-interactions-proof.fixture.ts";

test("split tray reads, archives, restores, filters, and opens the full Inbox", async ({
	page,
}) => {
	const notifications = [
		makeNotification("build-finished", "Build finished"),
		makeNotification("security-alert", "Security alert", { level: "warning" }),
		...Array.from({ length: 6 }, (_, index) =>
			makeNotification(`activity-${index + 1}`, `Project activity ${index + 1}`)
		),
		makeNotification("older-alert", "Previously archived alert", {
			archived: true,
			level: "error",
		}),
	];
	const fixture = createInboxFixture({ notifications });
	const { trigger } = await mountInbox(page, fixture);

	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByRole("tab", { name: "Unread" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	const fullInboxMore = page.getByRole("button", {
		name: "2 more in the full inbox",
		exact: true,
	});
	await expect(fullInboxMore).toBeVisible();
	await expect(fullInboxMore).toBeInViewport();
	await capture(page, "inbox-center-split-notification-tray.png");
	await fullInboxMore.click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");

	await clearOpenedTabs(page);
	await trigger.click();
	const securityAlert = rowFor(page, "Open Security alert in the inbox");
	fixture.failNext(
		"POST",
		"/api/notifications/security-alert/archive",
		"Archive is temporarily unavailable."
	);
	await securityAlert
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect(
		page.getByText("/api/notifications/security-alert/archive failed: 503")
	).toBeVisible();
	await expect(securityAlert).toBeVisible();
	await securityAlert
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "security-alert")
					?.archived_at
		)
		.toBe(NOW);
	await expect(securityAlert).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "security-alert")
					?.read_at
		)
		.toBe(NOW);
	await capture(page, "inbox-center-split-archived-unread-filter.png");

	const archiveCalls = fixture.calls.filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/security-alert/archive"
	);
	expect(archiveCalls.map((call) => call.status)).toEqual([503, 200]);
	await page.getByRole("tab", { name: "Archived" }).click();
	const archivedSecurityAlert = rowFor(
		page,
		"Open Security alert in the inbox"
	);
	await expect(archivedSecurityAlert).toBeVisible();
	await archivedSecurityAlert
		.getByRole("button", { name: "Restore to inbox", exact: true })
		.click();
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "security-alert")
					?.archived_at
		)
		.toBeNull();
	await expect(archivedSecurityAlert).toHaveCount(0);
	const restoreCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/security-alert/unarchive"
	);
	expect(restoreCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/security-alert/unarchive",
		status: 200,
	});

	await page.getByRole("tab", { name: "All" }).click();
	await expect(rowFor(page, "Open Security alert in the inbox")).toBeVisible();
	await page.getByRole("tab", { name: "Warning" }).click();
	await expect(rowFor(page, "Open Security alert in the inbox")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Open Build finished in the inbox" })
	).toHaveCount(0);
	await page.getByRole("tab", { name: "All" }).click();
	await page
		.getByRole("button", { name: "Open Build finished in the inbox" })
		.click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find((item) => item.id === "build-finished")
					?.read_at
		)
		.toBe(NOW);
	const readCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/build-finished/read"
	);
	expect(readCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/build-finished/read",
		status: 200,
	});
	await expect(trigger).toHaveAttribute("aria-expanded", "false");

	await clearOpenedTabs(page);
	await trigger.click();
	await page.getByRole("tab", { name: "Unread" }).click();
	await expect(
		page.getByRole("button", { name: "Open Build finished in the inbox" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Open inbox", exact: true }).click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	assertNoUnhandledFixtureRoutes(fixture);
});

test("split approval and task actions send exact decisions, expose pending state, and recover after errors", async ({
	page,
}) => {
	const fixture = createInboxFixture({
		approvals: [
			makeApproval("approval-approve", "Approve nightly deploy"),
			makeApproval("approval-reject", "Reject credential export", [
				"credential_access",
			]),
		],
		quests: [
			makeQuest("quest-done", "Prepare release notes"),
			makeQuest("quest-dismiss", "Review changelog"),
		],
	});
	const { trigger } = await mountInbox(page, fixture);
	await trigger.click();

	const approveGate = fixture.gateNext(
		"POST",
		"/api/approvals/approval-approve/approve"
	);
	const approveRow = rowFor(page, "Open Approve nightly deploy in the inbox");
	await approveRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	await expect.poll(() => approveGate.started).toBe(true);
	await expect(
		approveRow.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	await expect(
		approveRow.getByRole("button", { name: "Reject", exact: true })
	).toHaveCount(0);
	await capture(page, "inbox-center-split-approval-pending.png");
	approveGate.release();
	await expect(approveRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.approvals.find((item) => item.id === "approval-approve")
					?.status
		)
		.toBe("approved");
	expect(
		fixture.calls.find(
			(call) => call.path === "/api/approvals/approval-approve/approve"
		)
	).toEqual({
		body: {},
		method: "POST",
		path: "/api/approvals/approval-approve/approve",
		status: 200,
	});

	fixture.failNext(
		"POST",
		"/api/approvals/approval-reject/reject",
		"Approval fixture denied the request."
	);
	const rejectRow = rowFor(page, "Open Reject credential export in the inbox");
	await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(
		page.getByText("/api/approvals/approval-reject/reject failed: 503")
	).toBeVisible();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(rejectRow).toBeVisible();
	await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(rejectRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.approvals.find((item) => item.id === "approval-reject")
					?.status
		)
		.toBe("rejected");
	const rejectCalls = fixture.calls.filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/approvals/approval-reject/reject"
	);
	expect(rejectCalls).toEqual([
		{
			body: {},
			method: "POST",
			path: "/api/approvals/approval-reject/reject",
			status: 503,
		},
		{
			body: {},
			method: "POST",
			path: "/api/approvals/approval-reject/reject",
			status: 200,
		},
	]);

	const doneRow = rowFor(page, "Open Prepare release notes in the inbox");
	await doneRow.getByRole("button", { name: "Done", exact: true }).click();
	await expect(doneRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.quests.find((item) => item.id === "quest-done")?.status
		)
		.toBe("done");
	expect(
		fixture.calls.find(
			(call) => call.path === "/api/quests/quest-done/suggestion/accept"
		)
	).toEqual({
		body: null,
		method: "POST",
		path: "/api/quests/quest-done/suggestion/accept",
		status: 200,
	});

	fixture.failNext(
		"POST",
		"/api/quests/quest-dismiss/suggestion/dismiss",
		"Task suggestion fixture denied the request."
	);
	const dismissRow = rowFor(page, "Open Review changelog in the inbox");
	await dismissRow
		.getByRole("button", { name: "Not yet", exact: true })
		.click();
	await expect(
		page.getByText("/api/quests/quest-dismiss/suggestion/dismiss failed: 503")
	).toBeVisible();
	await expect(dismissRow).toBeVisible();
	await dismissRow
		.getByRole("button", { name: "Not yet", exact: true })
		.click();
	await expect(dismissRow).toHaveCount(0);
	const dismissCalls = fixture.calls.filter(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/quests/quest-dismiss/suggestion/dismiss"
	);
	expect(dismissCalls.map((call) => call.status)).toEqual([503, 200]);
	assertNoUnhandledFixtureRoutes(fixture);
});

test("unified stack decisions keep the right actions disabled, filter rows, and route into the Inbox", async ({
	page,
}) => {
	const fixture = createInboxFixture({
		approvals: [
			makeApproval("unified-approve", "Approve production rollout"),
			makeApproval("unified-reject", "Reject external transfer"),
		],
		notifications: [
			makeNotification("unified-release", "Unified release ready"),
			makeNotification("unified-warning", "Unified warning", {
				level: "warning",
			}),
			makeNotification("unified-archived", "Unified archived note", {
				archived: true,
			}),
		],
		quests: [
			makeQuest("unified-done", "Write deployment notes"),
			makeQuest("unified-dismiss", "Check dashboard alerts"),
		],
	});
	const { trigger } = await mountInbox(page, fixture, { layout: "unified" });
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("Escape");
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(trigger).toBeFocused();
	await trigger.click();
	await capture(page, "inbox-center-unified-stack-open.png");

	const approveGate = fixture.gateNext(
		"POST",
		"/api/approvals/unified-approve/approve"
	);
	const approveRow = rowFor(
		page,
		"Open Approve production rollout in the inbox"
	);
	await approveRow
		.getByRole("button", { name: "Approve", exact: true })
		.click();
	await expect.poll(() => approveGate.started).toBe(true);
	await expect(
		approveRow.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
	await expect(
		approveRow.getByRole("button", { name: "Reject", exact: true })
	).toHaveCount(0);
	await expect(
		approveRow.getByRole("status", { name: "Approval decision pending" })
	).toBeVisible();
	await capture(page, "inbox-center-unified-approval-disabled.png");
	approveGate.release();
	await expect(approveRow).toHaveCount(0);

	const rejectRow = rowFor(page, "Open Reject external transfer in the inbox");
	await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(rejectRow).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.approvals.find((item) => item.id === "unified-reject")
					?.status
		)
		.toBe("rejected");

	const doneGate = fixture.gateNext(
		"POST",
		"/api/quests/unified-done/suggestion/accept"
	);
	const doneRow = rowFor(page, "Open Write deployment notes in the inbox");
	await doneRow.getByRole("button", { name: "Done", exact: true }).click();
	await expect.poll(() => doneGate.started).toBe(true);
	await expect(
		doneRow.getByRole("button", { name: "Done", exact: true })
	).toHaveCount(0);
	await expect(
		doneRow.getByRole("button", { name: "Not yet", exact: true })
	).toHaveCount(0);
	await expect(
		doneRow.getByRole("status", { name: "Task suggestion decision pending" })
	).toBeVisible();
	doneGate.release();
	await expect(doneRow).toHaveCount(0);

	const dismissRow = rowFor(page, "Open Check dashboard alerts in the inbox");
	await dismissRow
		.getByRole("button", { name: "Not yet", exact: true })
		.click();
	await expect(dismissRow).toHaveCount(0);

	await page.getByRole("tab", { name: "Archived" }).click();
	const archivedNotice = rowFor(
		page,
		"Open Unified archived note in the inbox"
	);
	await expect(archivedNotice).toBeVisible();
	await expect(
		rowFor(page, "Open Unified release ready in the inbox")
	).toHaveCount(0);
	await capture(page, "inbox-center-unified-archived-filter.png");
	await page.getByRole("tab", { name: "Warning" }).click();
	await expect(rowFor(page, "Open Unified warning in the inbox")).toBeVisible();
	await expect(
		rowFor(page, "Open Unified release ready in the inbox")
	).toHaveCount(0);
	await page.getByRole("tab", { name: "Unread" }).click();
	const releaseNotice = rowFor(page, "Open Unified release ready in the inbox");
	await releaseNotice
		.getByRole("button", { name: "Archive", exact: true })
		.click();
	await expect(releaseNotice).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find(
					(item) => item.id === "unified-release"
				)?.archived_at
		)
		.toBe(NOW);
	const archiveCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/unified-release/archive"
	);
	expect(archiveCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/unified-release/archive",
		status: 200,
	});
	await page.getByRole("tab", { name: "Archived" }).click();
	const archivedReleaseNotice = rowFor(
		page,
		"Open Unified release ready in the inbox"
	);
	await archivedReleaseNotice
		.getByRole("button", { name: "Restore to inbox", exact: true })
		.click();
	await expect(archivedReleaseNotice).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.state.notifications.find(
					(item) => item.id === "unified-release"
				)?.archived_at
		)
		.toBeNull();
	const restoreCall = fixture.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/notifications/unified-release/unarchive"
	);
	expect(restoreCall).toEqual({
		body: null,
		method: "POST",
		path: "/api/notifications/unified-release/unarchive",
		status: 200,
	});
	await page.getByRole("tab", { name: "All" }).click();
	await expect(
		rowFor(page, "Open Unified release ready in the inbox")
	).toBeVisible();
	await page
		.getByRole("button", { name: /notifications\. Open inbox\./u })
		.click();
	await expect.poll(() => openedTabs(page)).toEqual(["/inbox"]);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	assertNoUnhandledFixtureRoutes(fixture);
});

for (const layout of ["split", "unified"] as const) {
	test(`${layout} announcement detail loads, marks read, reopens, and closes`, async ({
		page,
	}) => {
		const announcement = makeAnnouncement();
		const fixture = createInboxFixture({ announcements: [announcement] });
		const { trigger } = await mountInbox(page, fixture, {
			announcements: true,
			layout,
		});
		const detail = page.getByTestId("announcement-detail-dialog");
		await expect(detail).toBeVisible();
		await expect(
			detail.getByRole("heading", { name: "A clearer Ryu Inbox" })
		).toBeVisible();
		await expect(detail).toContainText(
			"The Inbox now groups decisions, app notifications, and product updates."
		);
		await expect
			.poll(
				() =>
					fixture.state.announcements.find(
						(item) => item.id === announcement.id
					)?.read
			)
			.toBe(true);
		const readCall = fixture.calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/api/announcements/${announcement.id}/read`
		);
		expect(readCall).toEqual({
			body: null,
			method: "POST",
			path: `/api/announcements/${announcement.id}/read`,
			status: 200,
		});
		await capture(page, `inbox-center-${layout}-announcement-detail.png`);

		await detail.getByRole("button", { name: "Done", exact: true }).click();
		await expect(detail).toBeHidden();
		await trigger.click();
		await page.getByRole("tab", { name: "All" }).click();
		const announcementRow = page.getByRole("button", {
			name: "Open A clearer Ryu Inbox",
			exact: true,
		});
		await announcementRow.click();
		await expect(detail).toBeVisible();
		await detail
			.getByRole("button", { name: "Learn more", exact: true })
			.click();
		await expect(detail).toBeHidden();
		expect(
			await page.evaluate(() => window.__inboxCenterProof.externalUrls())
		).toEqual(["https://ryu.example/updates/inbox"]);
		await expect(trigger).toHaveAttribute("aria-expanded", "false");
		await trigger.click();
		await page.getByRole("tab", { name: "All" }).click();
		const dismissButton = page.getByRole("button", {
			name: "Dismiss announcement",
			exact: true,
		});
		await dismissButton.click();
		await expect
			.poll(() =>
				fixture.state.announcements.some((item) => item.id === announcement.id)
			)
			.toBe(false);
		await expect
			.poll(() =>
				fixture.calls.some(
					(call) =>
						call.method === "POST" &&
						call.path === `/api/announcements/${announcement.id}/dismiss`
				)
			)
			.toBe(true);
		const dismissCall = fixture.calls.find(
			(call) =>
				call.method === "POST" &&
				call.path === `/api/announcements/${announcement.id}/dismiss`
		);
		expect(dismissCall).toEqual({
			body: null,
			method: "POST",
			path: `/api/announcements/${announcement.id}/dismiss`,
			status: 200,
		});
		assertNoUnhandledFixtureRoutes(fixture);
	});
}

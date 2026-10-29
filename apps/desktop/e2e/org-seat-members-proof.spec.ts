import path from "node:path";
import { expect, test } from "@playwright/test";
import { invitations } from "./harness/stubs/org-seat-auth-client.ts";

test("shows active and allocated capacity and blocks an over-cap invite", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			errors.push(message.text());
		}
	});

	// Ryu's sent-invitations API: the live pending invitations, one page. The
	// dialog reads this, not Better Auth's `list-invitations`, which stops after
	// 100 stored rows (the auth client stub has no such method, so a call fails
	// the proof).
	const sentRequests: string[] = [];
	await page.route(
		"**/api/organization-invitations/orgs/*/sent*",
		async (route) => {
			const url = new URL(route.request().url());
			sentRequests.push(`${url.pathname}${url.search}`);
			await route.fulfill({
				body: JSON.stringify({
					invitations: invitations.map((invitation) => ({
						...invitation,
						createdAt: "2026-10-14T00:00:00.000Z",
						expiresAt: "2026-10-31T00:00:00.000Z",
						inviterId: "user-owner",
						organizationId: "org-northstar",
						referralTag: null,
					})),
					nextCursor: null,
				}),
				contentType: "application/json",
				status: 200,
			});
		}
	);

	await page.goto("/org-seat-members-proof.html");
	await expect(page.getByTestId("proof-status")).toHaveText("VERIFIED");
	await expect(page.getByTestId("organization-seat-count")).toHaveText(
		"4/5 seats"
	);
	await expect(page.getByTestId("organization-seat-allocation")).toHaveText(
		"5/5 allocated"
	);
	await expect(
		page.getByRole("button", { name: "Send invite" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Buy more seats" })
	).toBeVisible();
	await expect(
		page.getByText("1 pending invitation reserved", { exact: false })
	).toBeVisible();
	await expect(page.getByText("finance@northstar.example")).toBeVisible();
	await expect(
		page.getByLabel("Members").getByText("Platform", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Resend invitation to finance@northstar.example",
		})
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			test.info().project.testDir,
			"proof",
			"org-seat-members-invite-controls-proof.png"
		),
	});
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByTestId("active-team-control")).toBeVisible();
	await page.getByRole("combobox", { name: "Active team" }).click();
	await page.getByRole("option", { name: "Design" }).click();
	await expect(
		page.getByRole("combobox", { name: "Active team" })
	).toContainText("Design");
	await page.screenshot({
		fullPage: true,
		path: path.resolve(
			test.info().project.testDir,
			"proof",
			"org-seat-members-active-team-proof.png"
		),
	});

	expect(sentRequests).toEqual([
		"/api/organization-invitations/orgs/org-northstar/sent?limit=200",
	]);
	if (errors.length > 0) {
		throw new Error(
			`Organization seat proof logged errors: ${errors.join(" | ")}`
		);
	}
});

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const evidencePath = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence/identities-page-selected-detail-after-cancel.png"
);

const profiles = [
	{
		connections: [
			{
				created_at: 1,
				domain: "alpha.example.test",
				flow_status: "DONE",
				id: "connection-alpha",
				last_checked: 1,
				profile_id: "work",
				source: "manual",
				status: "AUTHENTICATED",
				updated_at: 1,
			},
			{
				created_at: 2,
				domain: "beta.example.test",
				flow_status: "IDLE",
				id: "connection-beta",
				last_checked: 0,
				profile_id: "work",
				source: "manual",
				status: "NEEDS_AUTH",
				updated_at: 2,
			},
		],
		profile_id: "work",
	},
];

test("the real Identities page keeps the selected connection visible after create is canceled", async ({
	page,
}) => {
	const calls: { method: string; path: string }[] = [];
	await page.route("**/api/identities**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		calls.push({ method: request.method(), path });
		if (request.method() === "GET" && path === "/api/identities") {
			await route.fulfill({ json: { profiles } });
			return;
		}
		await route.fulfill({
			status: 404,
			json: { error: "Unexpected proof request" },
		});
	});

	await page.goto("identities-page-proof.html");
	await expect(
		page.getByRole("heading", { name: "alpha.example.test" })
	).toBeVisible();
	await page.getByRole("button", { name: "beta.example.test" }).click();
	await expect(
		page.getByRole("heading", { name: "beta.example.test" })
	).toBeVisible();
	await page.locator('button[title="New connection"]').click();
	await expect(
		page.getByRole("heading", { name: "New connection" })
	).toBeVisible();
	await expect(page.locator("#identity-profile-ids option")).toHaveAttribute(
		"value",
		"work"
	);
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(
		page.getByRole("heading", { name: "beta.example.test" })
	).toBeVisible();
	await expect(page.getByText("Needs auth")).toBeVisible();
	expect(calls).toEqual([{ method: "GET", path: "/api/identities" }]);
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await page.screenshot({ fullPage: true, path: evidencePath });
});

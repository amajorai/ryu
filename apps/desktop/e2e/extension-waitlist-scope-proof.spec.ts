import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WAITLIST_MANAGED_ONLY_FLAG } from "@ryuhq/protocol/feature-flags";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../..",
	"docs/proof/waitlist-managed-nodes"
);

test.afterEach(async ({ page }) => {
	if (!page.isClosed()) {
		await page.close();
	}
});

async function stubManagedOnlyFlag(page: Page, enabled: boolean) {
	await page.route("**/api/feature-flags/public", (route) =>
		route.fulfill({
			contentType: "application/json",
			json: {
				features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: enabled },
			},
		})
	);
}

async function stubManagedNodes(page: Page, requests: string[]) {
	await page.route("**/api/control-plane/nodes", async (route) => {
		requests.push(route.request().url());
		await route.fulfill({
			contentType: "application/json",
			json: { nodes: [{ url: "https://managed.example.test/" }] },
		});
	});
}

async function stubWaitlist(page: Page, requests: string[]) {
	await page.route("**/api/waitlist/me", async (route) => {
		requests.push(route.request().url());
		await route.fulfill({
			contentType: "application/json",
			json: { status: "pending" },
		});
	});
}

async function saveProof(page: Page, filename: string) {
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, filename),
		fullPage: true,
		animations: "disabled",
	});
}

test("the default all-node policy gates a local node", async ({ page }) => {
	const managedNodeRequests: string[] = [];
	const waitlistRequests: string[] = [];
	await stubManagedOnlyFlag(page, false);
	await stubManagedNodes(page, managedNodeRequests);
	await stubWaitlist(page, waitlistRequests);

	await page.goto("/extension-waitlist-scope-proof.html?node=local", {
		waitUntil: "commit",
	});
	await expect(
		page.getByRole("heading", { name: "You're on the waitlist" })
	).toBeVisible();
	expect(managedNodeRequests).toHaveLength(0);
	expect(waitlistRequests).toHaveLength(1);

	await saveProof(page, "extension-all-nodes-local-waitlist.png");
});

test("the managed-only server policy lets a local node bypass", async ({
	page,
}) => {
	const managedNodeRequests: string[] = [];
	const waitlistRequests: string[] = [];
	await stubManagedOnlyFlag(page, true);
	await stubManagedNodes(page, managedNodeRequests);
	await stubWaitlist(page, waitlistRequests);

	await page.goto("/extension-waitlist-scope-proof.html?node=local", {
		waitUntil: "commit",
	});
	await expect(
		page.getByRole("heading", { name: "Workspace unlocked" })
	).toBeVisible();
	expect(managedNodeRequests).toHaveLength(1);
	expect(waitlistRequests).toHaveLength(0);

	await saveProof(page, "extension-local-bypass.png");
});

test("the managed-only server policy gates a managed node", async ({
	page,
}) => {
	const managedNodeRequests: string[] = [];
	const waitlistRequests: string[] = [];
	await stubManagedOnlyFlag(page, true);
	await stubManagedNodes(page, managedNodeRequests);
	await stubWaitlist(page, waitlistRequests);

	await page.goto("/extension-waitlist-scope-proof.html?node=managed", {
		waitUntil: "commit",
	});
	await expect(
		page.getByRole("heading", { name: "You're on the waitlist" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Workspace unlocked" })
	).not.toBeVisible();
	expect(managedNodeRequests).toHaveLength(1);
	expect(waitlistRequests).toHaveLength(1);

	await saveProof(page, "extension-managed-waitlist.png");
});

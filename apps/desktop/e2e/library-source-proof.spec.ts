import path from "node:path";
import { expect, test } from "@playwright/test";

const evidence = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-data-flows/memory-library"
);
const rows = {
	items: [
		{
			id: "release /?&",
			title: "Release checklist",
			subtitle: "Ready for review",
			status: "Ready",
		},
		{
			id: "draft",
			title: "Design brief",
			subtitle: "Draft notes",
			status: "Draft",
		},
	],
};
for (const view of [
	"list",
	"table",
	"board",
	"calendar",
	"timeline",
	"feed",
	"gallery",
	"card",
]) {
	test(`${view} collection filters and opens the encoded production target exactly once`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const requests: { method: string; auth?: string }[] = [];
		await page.route("**/api/records", async (route) => {
			requests.push({
				method: route.request().method(),
				auth: route.request().headers().authorization,
			});
			await route.fulfill({ json: rows });
		});
		await page.goto(`/library-source-proof.html?view=${view}`);
		await expect(
			page.getByText("Release checklist", { exact: true }).first()
		).toBeVisible();
		await page.getByLabel("Search collection").fill("  ready  ");
		await expect(page.getByText("Design brief", { exact: true })).toHaveCount(
			0
		);
		const row = page.getByRole("button", { name: /Release checklist/ }).first();
		if (view === "table") {
			await row.focus();
			await row.press("Enter");
		} else {
			await row.click();
		}
		await expect(page.getByLabel("Opened collection item")).toHaveText(
			JSON.stringify({
				path: "/chat",
				options: { conversationId: "release /?&", title: "Release checklist" },
			})
		);
		expect(requests).toEqual([
			{ method: "GET", auth: "Bearer collection-token" },
		]);
		expect(errors).toEqual([]);
		if (view === "table") {
			await page.screenshot({
				path: path.join(evidence, "completed-library-keyboard-open.png"),
				fullPage: true,
			});
		}
	});
}
test("a forbidden or failed source read is an error and reload reads the recovered collection", async ({
	page,
}) => {
	let status = 403;
	await page.route("**/api/records", (route) =>
		status === 200
			? route.fulfill({ json: rows })
			: route.fulfill({ status, json: { error: "Denied" } })
	);
	await page.goto("/library-source-proof.html");
	await expect(page.getByText("Unable to load", { exact: true })).toBeVisible();
	await expect(page.getByText("Nothing yet", { exact: true })).toHaveCount(0);
	status = 503;
	await page.reload();
	await expect(page.getByText("Unable to load", { exact: true })).toBeVisible();
	status = 200;
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Release checklist", exact: true })
	).toBeVisible();
	await page.screenshot({
		path: path.join(evidence, "completed-library-read-recovered.png"),
		fullPage: true,
	});
});
test("unapproved declarative reads issue no request", async ({ page }) => {
	let count = 0;
	await page.route("**/api/records", async (route) => {
		count++;
		await route.fulfill({ json: rows });
	});
	await page.goto("/library-source-proof.html?denied=true");
	await expect(page.getByText("Nothing yet", { exact: true })).toBeVisible();
	expect(count).toBe(0);
});
test("a slow old node cannot replace a newer node collection", async ({
	page,
}) => {
	let resolveOld!: () => void;
	const held = new Promise<void>((resolve) => {
		resolveOld = resolve;
	});
	const tokens: string[] = [];
	await page.route("**/api/records", async (route) => {
		const token = route.request().headers().authorization;
		tokens.push(token);
		if (token === "Bearer collection-token") {
			await held;
			await route
				.fulfill({ json: { items: [{ id: "old", title: "Old node secret" }] } })
				.catch(() => undefined);
		} else {
			await route.fulfill({
				json: { items: [{ id: "new", title: "New node collection" }] },
			});
		}
	});
	await page.goto("/library-source-proof.html");
	await expect.poll(() => tokens.length).toBe(1);
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("collection-node", {
				detail: {
					url: window.location.origin,
					token: "new-node-token",
					userJwt: null,
				},
			})
		)
	);
	await expect(
		page.getByRole("button", { name: "New node collection", exact: true })
	).toBeVisible();
	resolveOld();
	await expect(page.getByText("Old node secret", { exact: true })).toHaveCount(
		0
	);
	expect(tokens).toEqual(["Bearer collection-token", "Bearer new-node-token"]);
	await page.screenshot({
		path: path.join(evidence, "completed-library-new-node-readback.png"),
		fullPage: true,
	});
});

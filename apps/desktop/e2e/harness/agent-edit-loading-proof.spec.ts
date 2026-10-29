import { expect, test } from "@playwright/test";

test("existing agent loads, edits, and switches tabs without changing hook order", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		let body = {};
		if (pathname === "/api/agents/proof-agent") {
			await new Promise((resolve) => setTimeout(resolve, 1500));
			body = {
				agent: {
					id: "proof-agent",
					name: "Release desk",
					description: "Review release changes",
					system_prompt: "Review carefully",
					engine: "ryu",
					tools: [],
					skills: [],
					built_in: false,
					locked: false,
					version: "0.1.0",
					created_at: "2026-10-04T00:00:00Z",
					updated_at: "2026-10-04T00:00:00Z",
				},
			};
		} else if (pathname === "/api/agents") {
			body = { agents: [] };
		} else if (pathname.includes("engines")) {
			body = { engines: [], active: null };
		} else if (pathname.includes("skills")) {
			body = { skills: [] };
		} else if (pathname.includes("mcp")) {
			body = { tools: [] };
		} else if (pathname.includes("output-styles")) {
			body = { styles: [] };
		} else if (pathname.includes("trigger")) {
			body = { subscriptions: [] };
		} else if (pathname.includes("spaces")) {
			body = { spaces: [] };
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(body),
		});
	});
	await page.goto("/agent-edit-loading-proof.html");
	const name = page.locator('input[value="Release desk"]');
	await expect(name).toBeVisible();
	await name.fill("Release review desk");
	await page.getByText("Health", { exact: true }).click();
	await page.getByText("Behavior", { exact: true }).click();
	await expect(
		page.locator('input[value="Release review desk"]')
	).toBeVisible();
	expect(errors).toEqual([]);
});

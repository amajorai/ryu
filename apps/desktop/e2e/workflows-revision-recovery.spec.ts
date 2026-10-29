import { expect, type Page, test } from "@playwright/test";
import { parseWorkflowRevisionSnapshot } from "./workflow-fixture-contract.ts";

const seed = {
	id: "revision-workflow",
	name: "Original workflow",
	updatedAt: "revision-1",
	nodes: [
		{ id: "input", type: "input" },
		{ id: "output", type: "output" },
	],
	edges: [{ from: "input", to: "output" }],
	triggers: [{ type: "manual" }],
};

async function state(page: Page) {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBeTruthy();
	return parseWorkflowRevisionSnapshot(await response.text());
}

for (const action of ["Save", "Save version"]) {
	test(`${action} refuses stale revision, preserves edits, and explicitly reloads before retry`, async ({
		page,
	}) => {
		const pageErrors: string[] = [];
		const failedRequests: string[] = [];
		const errorResponses: { path: string; status: number }[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("requestfailed", (request) =>
			failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`)
		);
		page.on("response", (response) => {
			if (response.status() >= 400) {
				errorResponses.push({
					path: new URL(response.url()).pathname,
					status: response.status(),
				});
			}
		});
		await page.request.post("/__fixture/reset", {
			data: { workflows: [seed], failures: { "workflows.get": 1 } },
		});
		await page.goto("/?workflowId=revision-workflow");
		const name = page.getByRole("textbox", {
			name: "Workflow name",
			exact: true,
		});
		await expect(name).toHaveValue(seed.name);
		await name.fill("My unsaved draft");
		await page.locator('.react-flow__node[data-id="__trigger__"]').click();
		await page.getByLabel("When this runs").click();
		await page.getByRole("option", { name: "Schedule", exact: true }).click();
		await page.getByLabel("Every").click();
		await page
			.getByRole("option", { name: "Custom cron", exact: true })
			.click();
		await page.getByLabel("Cron").fill("0 9 * * 1-5");
		const draftTrigger = [
			{ type: "schedule", cron: "0 9 * * 1-5", every: null },
		];
		const inputNode = page.locator('.react-flow__node[data-id="input"]');
		const initialPosition = await inputNode.getAttribute("style");
		const initialCoordinates = await inputNode.evaluate((node) => {
			const matrix = new DOMMatrix(getComputedStyle(node).transform);
			return { x: matrix.m41, y: matrix.m42 };
		});
		const bounds = await inputNode.boundingBox();
		expect(bounds).not.toBeNull();
		if (bounds) {
			await page.mouse.move(
				bounds.x + bounds.width / 2,
				bounds.y + bounds.height / 2
			);
			await page.mouse.down();
			await page.mouse.move(
				bounds.x + bounds.width / 2 + 100,
				bounds.y + bounds.height / 2 + 80,
				{ steps: 12 }
			);
			await page.mouse.up();
		}
		const draftPosition = await inputNode.getAttribute("style");
		expect(draftPosition).not.toBe(initialPosition);
		const draftCoordinates = await inputNode.evaluate((node) => {
			const matrix = new DOMMatrix(getComputedStyle(node).transform);
			return { x: matrix.m41, y: matrix.m42 };
		});
		expect(
			Math.hypot(
				draftCoordinates.x - initialCoordinates.x,
				draftCoordinates.y - initialCoordinates.y
			)
		).toBeGreaterThan(10);
		await page.request.post("/__fixture/external-save", {
			data: {
				name: "Remote latest",
				triggers: [{ type: "manual" }],
				nodes: [...seed.nodes, { id: "remote", type: "input", key: "remote" }],
			},
		});
		let releaseSave: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		await page.route("**/__fixture/workflows.save", async (route) => {
			await held;
			await route.continue();
		});
		await page.getByRole("button", { name: action, exact: true }).click();
		await expect(
			page.getByRole("button", { name: new RegExp(`${action}$`) })
		).toBeDisabled();
		await name.fill("Draft edited while saving");
		await expect(name).toHaveValue("Draft edited while saving");
		expect((await state(page)).versions).toHaveLength(0);
		releaseSave?.();
		await expect(page.getByRole("alert")).toContainText(
			"changed since it was loaded"
		);
		await expect(name).toHaveValue("Draft edited while saving");
		await expect(inputNode).toHaveAttribute("style", draftPosition ?? "");
		const refused = await state(page);
		expect(
			refused.calls.filter((call) => call.method === "workflows.save")
		).toEqual([
			{
				method: "workflows.save",
				args: expect.objectContaining({
					id: seed.id,
					name: "My unsaved draft",
					updated_at: "revision-1",
					triggers: draftTrigger,
					edges: seed.edges,
				}),
			},
		]);
		expect(refused.versions).toHaveLength(0);
		expect(refused.workflows[0]?.name).toBe("Remote latest");
		await page.getByRole("button", { name: "Reload latest workflow" }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.getByRole("button", { name: "Keep editing" }).click();
		await expect(name).toHaveValue("Draft edited while saving");
		await expect(inputNode).toHaveAttribute("style", draftPosition ?? "");
		await page.locator('.react-flow__node[data-id="__trigger__"]').click();
		await expect(page.getByLabel("Cron")).toHaveValue("0 9 * * 1-5");
		expect(
			(await state(page)).calls.filter(
				(call) => call.method === "workflows.get"
			)
		).toHaveLength(0);
		await page.getByRole("button", { name: "Reload latest workflow" }).click();
		await page
			.getByRole("button", { name: "Discard edits and reload", exact: true })
			.click();
		await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
			"temporarily unavailable"
		);
		// The open modal correctly hides the background from the accessibility
		// tree. Inspect its retained input value without dismissing recovery.
		await expect(page.locator('input[aria-label="Workflow name"]')).toHaveValue(
			"Draft edited while saving"
		);
		await expect(inputNode).toHaveAttribute("style", draftPosition ?? "");
		await page
			.getByRole("button", { name: "Discard edits and reload", exact: true })
			.click();
		await expect(name).toHaveValue("Remote latest");
		await expect(
			page.locator('.react-flow__node[data-id="remote"]')
		).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.locator('.react-flow__node[data-id="__trigger__"]').click();
		await expect(page.getByLabel("When this runs")).toContainText("Manual");
		const latestBounds = await inputNode.boundingBox();
		expect(latestBounds).not.toBeNull();
		const beforeFinalDrag = await inputNode.getAttribute("style");
		const beforeFinalCoordinates = await inputNode.evaluate((node) => {
			const matrix = new DOMMatrix(getComputedStyle(node).transform);
			return { x: matrix.m41, y: matrix.m42 };
		});
		if (latestBounds) {
			await page.mouse.move(
				latestBounds.x + latestBounds.width / 2,
				latestBounds.y + latestBounds.height / 2
			);
			await page.mouse.down();
			await page.mouse.move(
				latestBounds.x + latestBounds.width / 2 + 75,
				latestBounds.y + latestBounds.height / 2 + 55,
				{ steps: 12 }
			);
			await page.mouse.up();
		}
		const finalNodePosition = await inputNode.evaluate((node) => {
			const matrix = new DOMMatrix(getComputedStyle(node).transform);
			return { x: matrix.m41, y: matrix.m42 };
		});
		expect(await inputNode.getAttribute("style")).not.toBe(beforeFinalDrag);
		expect(
			Math.hypot(
				finalNodePosition.x - beforeFinalCoordinates.x,
				finalNodePosition.y - beforeFinalCoordinates.y
			)
		).toBeGreaterThan(10);
		await name.fill("Reviewed latest");
		await page.getByRole("button", { name: action, exact: true }).click();
		await expect
			.poll(async () => (await state(page)).workflows[0]?.name)
			.toBe("Reviewed latest");
		if (action === "Save version") {
			await expect
				.poll(async () => (await state(page)).versions.length)
				.toBe(1);
		}
		await expect
			.poll(() =>
				page.evaluate(() => {
					const positions = JSON.parse(
						localStorage.getItem("ryu:workflow:positions:revision-workflow") ??
							"{}"
					);
					return positions.input;
				})
			)
			.toEqual(finalNodePosition);
		const saved = await state(page);
		expect(
			saved.calls.filter((call) => call.method === "workflows.save")
		).toHaveLength(2);
		expect(
			saved.calls.filter((call) => call.method === "workflows.save")[1]?.args
		).toMatchObject({ updated_at: "revision-2", name: "Reviewed latest" });
		expect(
			saved.calls.filter((call) => call.method === "workflows.get")
		).toEqual([
			{ method: "workflows.get", args: { id: seed.id } },
			{ method: "workflows.get", args: { id: seed.id } },
		]);
		expect(saved.versions).toHaveLength(action === "Save version" ? 1 : 0);
		if (action === "Save version") {
			expect(saved.versions[0]?.workflow).toMatchObject({
				name: "Reviewed latest",
				updatedAt: "revision-3",
			});
		}
		expect(pageErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
		expect(errorResponses).toEqual([
			{ path: "/__fixture/workflows.save", status: 409 },
			{ path: "/__fixture/workflows.get", status: 503 },
		]);
		const allowedMethods = new Set([
			"workflows.list",
			"workflows.get",
			"workflows.save",
			"workflows.versionCreate",
			"workflows.versionsList",
			"workflows.hookEvents",
			"workflows.composio",
		]);
		expect(
			saved.calls.filter((call) => !allowedMethods.has(call.method))
		).toEqual([]);
		await page.reload();
		await expect(name).toHaveValue("Reviewed latest");
		await expect(
			page.locator('.react-flow__node[data-id="remote"]')
		).toBeVisible();
		await expect
			.poll(() =>
				inputNode.evaluate((node) => {
					const matrix = new DOMMatrix(getComputedStyle(node).transform);
					return { x: matrix.m41, y: matrix.m42 };
				})
			)
			.toEqual(finalNodePosition);
		await page.locator('.react-flow__node[data-id="__trigger__"]').click();
		await expect(page.getByLabel("When this runs")).toContainText("Manual");
		expect(
			(await state(page)).calls.filter(
				(call) => call.method === "workflows.save"
			)
		).toHaveLength(2);
		expect(pageErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
		await page.screenshot({
			path: test
				.info()
				.outputPath(`revision-recovery-${action.replaceAll(" ", "-")}.png`),
			fullPage: true,
		});
	});
}

test("checkpoint refuses a save between acknowledgement and version request, then reloads and retries", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.request.post("/__fixture/reset", { data: { workflows: [seed] } });
	await page.goto("/?workflowId=revision-workflow");
	const name = page.getByRole("textbox", {
		name: "Workflow name",
		exact: true,
	});
	await expect(name).toHaveValue(seed.name);
	await name.fill("Acknowledged draft");
	let reached: (() => void) | undefined;
	const versionRequested = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let release: (() => void) | undefined;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/__fixture/workflows.versionCreate", async (route) => {
		reached?.();
		await hold;
		await route.continue();
	});
	const conflictResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith("/__fixture/workflows.versionCreate") &&
			response.status() === 409
	);
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await versionRequested;
	const acknowledged = await state(page);
	expect(acknowledged.workflows[0]).toMatchObject({
		name: "Acknowledged draft",
		updatedAt: "revision-2",
	});
	expect(acknowledged.versions).toHaveLength(0);
	await name.fill("Draft edited while checkpointing");
	await page.request.post("/__fixture/external-save", {
		data: { name: "Latest shared save" },
	});
	release?.();
	expect(await (await conflictResponse).json()).toEqual({
		success: false,
		code: "workflow_revision_conflict",
		error: "workflow revision conflict: it was changed since it was saved",
		current_updated_at: "revision-3",
	});
	await expect(page.getByRole("alert").first()).toContainText(
		"Workflow saved, but the version was not saved"
	);
	await expect(name).toHaveValue("Draft edited while checkpointing");
	const refused = await state(page);
	expect(refused.versions).toHaveLength(0);
	expect(refused.workflows[0]).toMatchObject({
		name: "Latest shared save",
		updatedAt: "revision-3",
	});
	expect(
		refused.calls.filter((call) => call.method === "workflows.versionCreate")[0]
			?.args
	).toMatchObject({ id: seed.id, expectedRevision: "revision-2" });
	await page.getByRole("button", { name: "Reload latest workflow" }).click();
	await page
		.getByRole("button", { name: "Discard edits and reload", exact: true })
		.click();
	await expect(name).toHaveValue("Latest shared save");
	await page.unroute("**/__fixture/workflows.versionCreate");
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await expect.poll(async () => (await state(page)).versions.length).toBe(1);
	const completed = await state(page);
	expect(completed.versions[0]?.workflow).toMatchObject({
		name: "Latest shared save",
		updatedAt: "revision-4",
	});
	expect(
		completed.calls.filter(
			(call) => call.method === "workflows.versionCreate"
		)[1]?.args
	).toMatchObject({ id: seed.id, expectedRevision: "revision-4" });
	expect(
		completed.calls.filter((call) => call.method === "workflows.save")[1]?.args
	).toMatchObject({ updated_at: "revision-3" });
	await page.reload();
	await expect(name).toHaveValue("Latest shared save");
	expect((await state(page)).versions).toHaveLength(1);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: test.info().outputPath("checkpoint-revision-recovery-completed.png"),
		fullPage: true,
	});
});

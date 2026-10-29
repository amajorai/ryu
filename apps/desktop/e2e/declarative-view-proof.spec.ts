import path from "node:path";
import { expect, test } from "@playwright/test";

const plans = [
	{
		id: "plan/one",
		title: "Ship safe assets",
		status: "draft",
		current_revision: 3,
	},
	{
		id: "plan-two",
		title: "Validate native sign-in",
		status: "draft",
		current_revision: 7,
	},
];
test("Blueprint contributed view retries source failures, confirms deletion and reads exact approval truth", async ({
	page,
}) => {
	let reads = 0;
	const writes: {
		path: string;
		method: string;
		body: string | null;
		authorization: string | undefined;
	}[] = [];
	let rows = structuredClone(plans);
	let release: (() => void) | undefined;
	let failure = true;
	await page.route("**/api/blueprint/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		expect(request.headers().authorization).toBe(
			"Bearer declarative-node-token"
		);
		if (request.method() === "GET") {
			reads++;
			await route.fulfill(
				reads === 1
					? { status: 503, json: { error: "fixture unavailable" } }
					: { json: { plans: rows } }
			);
			return;
		}
		writes.push({
			path: url.pathname,
			method: request.method(),
			body: request.postData(),
			authorization: request.headers().authorization,
		});
		if (request.method() === "POST") {
			if (failure) {
				failure = false;
				await route.fulfill({
					status: 503,
					json: { error: "fixture write failed" },
				});
				return;
			}
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			rows = rows.map((row) =>
				row.id === "plan/one" ? { ...row, status: "approved" } : row
			);
		} else {
			rows = rows.filter((row) => row.id !== "plan-two");
		}
		await route.fulfill({ json: { ok: true } });
	});
	await page.goto("/declarative-view-proof.html");
	await expect(page.getByText("Couldn't load this view.")).toBeVisible();
	await expect(page.getByText("No plans have been published yet.")).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByText("Ship safe assets")).toBeVisible();
	await page
		.getByRole("button", { name: "Approve", exact: true })
		.first()
		.click();
	await expect.poll(() => writes.length).toBe(1);
	await expect(
		page.getByRole("button", { name: "Approve", exact: true }).first()
	).toBeEnabled();
	await page
		.getByRole("button", { name: "Approve", exact: true })
		.first()
		.click();
	await expect.poll(() => writes.length).toBe(2);
	await expect(
		page.getByRole("button", { name: "Approve", exact: true }).first()
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Delete plan" }).first()
	).toBeDisabled();
	release?.();
	await expect(page.getByText("approved", { exact: true })).toBeVisible();
	expect(writes.slice(0, 2)).toEqual(
		[1, 2].map(() => ({
			path: "/api/blueprint/plans/plan%2Fone/verdict",
			method: "POST",
			body: JSON.stringify({ verdict: "approved", revision: 3 }),
			authorization: "Bearer declarative-node-token",
		}))
	);
	await page.getByRole("button", { name: "Delete plan" }).nth(1).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Cancel" })
		.click();
	expect(writes).toHaveLength(2);
	await page.getByRole("button", { name: "Delete plan" }).nth(1).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Continue" })
		.click();
	await expect(page.getByText("Validate native sign-in")).toHaveCount(0);
	expect(writes[2]).toMatchObject({
		path: "/api/blueprint/plans/plan-two",
		method: "DELETE",
		body: null,
	});
	await page.reload();
	await expect(page.getByText("Ship safe assets")).toBeVisible();
	await expect(page.getByText("approved", { exact: true })).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			"../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-declarative/blueprint-approved-readback.png"
		),
		fullPage: true,
	});
});

test("Blueprint declarative HTTP grant denial never reads or mutates the node", async ({
	page,
}) => {
	const calls: string[] = [];
	await page.route("**/api/**", async (route) => {
		if (!new URL(route.request().url()).pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		calls.push(route.request().url());
		await route.fulfill({ json: { plans } });
	});
	await page.goto("/declarative-view-proof.html?deny");
	await expect(page.getByText("Couldn't load this view.")).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByText("Couldn't load this view.")).toBeVisible();
	expect(calls).toEqual([]);
	await expect(
		page.getByRole("button", { name: "Approve", exact: true })
	).toHaveCount(0);
});

test("Author form contributions preserve typed defaults, validation and exact HTTP and intent actions", async ({
	page,
}) => {
	const writes: { path: string; body: unknown }[] = [];
	let release: (() => void) | undefined;
	await page.route("**/api/**", async (route) => {
		if (!new URL(route.request().url()).pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}
		expect(route.request().headers().authorization).toBe(
			"Bearer declarative-node-token"
		);
		const pathname = new URL(route.request().url()).pathname;
		writes.push({ path: pathname, body: route.request().postDataJSON() });
		if (pathname.endsWith("/items")) {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}
		await route.fulfill({ json: { ok: true } });
	});
	await page.goto("/declarative-view-proof.html?custom");
	await expect(page.getByLabel("Count", { exact: true })).toHaveValue("0");
	await expect(page.getByLabel("Mode", { exact: true })).toHaveValue("fast");
	await expect(page.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0]).toEqual({
		path: "/api/plugins/com.example.author/host",
		body: {
			method: "view.action",
			args: {
				view_id: "author-form",
				action_id: "preview",
				intent: "preview",
				payload: null,
				values: {
					name: "Initial",
					notes: "Initial note",
					count: 0,
					enabled: false,
					mode: "fast",
				},
				item: null,
			},
		},
	});
	await page.getByLabel("Name", { exact: true }).fill("");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	expect(writes).toHaveLength(1);
	await page.getByLabel("Name", { exact: true }).fill("User title");
	await page.getByLabel("Notes", { exact: true }).fill("A useful note");
	await page.getByLabel("Count", { exact: true }).fill("4");
	await page.getByRole("switch", { name: "Enabled" }).click();
	await page.getByLabel("Mode", { exact: true }).selectOption("safe");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => writes.length).toBe(2);
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	expect(writes[1]).toEqual({
		path: "/api/ext/com.example.author/items",
		body: {
			name: "User title",
			notes: "A useful note",
			count: 4,
			enabled: true,
			mode: "safe",
		},
	});
	release?.();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();
	await page.screenshot({
		path: path.resolve(
			"../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-declarative/author-form-completed.png"
		),
		fullPage: true,
	});
});

test("Author list selection sends the selected record through the real intent transport", async ({
	page,
}) => {
	const payloads: unknown[] = [];
	await page.route("**/api/plugins/**", async (route) => {
		payloads.push(route.request().postDataJSON());
		await route.fulfill({ json: { ok: true } });
	});
	await page.goto("/declarative-view-proof.html?custom=list");
	await page.getByRole("button", { name: "Inspect selected" }).click();
	await expect.poll(() => payloads.length).toBe(1);
	expect(payloads[0]).toMatchObject({
		args: { item: { id: "first", title: "First record" } },
	});
	await page
		.getByRole("button", { name: "Second record", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "Inspect selected" }).click();
	await expect.poll(() => payloads.length).toBe(2);
	expect(payloads[1]).toMatchObject({
		args: { item: { id: "second", title: "Second record" } },
	});
});

test("Blueprint ignores a stale read and clears prior rows when the node scope loses grants", async ({
	page,
}) => {
	let reads = 0;
	let release: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tokens: string[] = [];
	await page.route("**/api/blueprint/plans", async (route) => {
		reads++;
		const index = reads;
		tokens.push(route.request().headers().authorization ?? "");
		if (index === 1) {
			await held;
		}
		await route.fulfill({
			json: {
				plans: [
					{
						...plans[0],
						title: index === 1 ? "Stale owner result" : "Current owner result",
					},
				],
			},
		});
	});
	await page.goto("/declarative-view-proof.html");
	await expect.poll(() => reads).toBe(1);
	await expect(page.getByText("Loading view…")).toBeVisible();
	const change = async (denied: boolean) =>
		page.evaluate(
			(value) =>
				window.dispatchEvent(
					new CustomEvent("declarative-scope", {
						detail: { token: "changed-node-token", denied: value },
					})
				),
			denied
		);
	await change(false);
	await expect(page.getByText("Current owner result")).toBeVisible();
	release?.();
	await expect(page.getByText("Stale owner result")).toHaveCount(0);
	await change(true);
	await expect(page.getByText("Couldn't load this view.")).toBeVisible();
	await expect(page.getByText("Current owner result")).toHaveCount(0);
	expect(reads).toBe(2);
	await change(false);
	await expect(page.getByText("Current owner result")).toBeVisible();
	expect(tokens).toEqual([
		"Bearer declarative-node-token",
		"Bearer changed-node-token",
		"Bearer changed-node-token",
	]);
});

test("Author form HTTP grant denial blocks a valid submit while retaining draft inputs", async ({
	page,
}) => {
	const calls: string[] = [];
	await page.route("**/api/ext/**", async (route) => {
		calls.push(route.request().url());
		await route.fulfill({ json: { ok: true } });
	});
	await page.goto("/declarative-view-proof.html?custom&deny");
	await page.getByLabel("Name", { exact: true }).fill("Retained draft");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("This view does not have declarative HTTP access.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Retained draft"
	);
	expect(calls).toEqual([]);
});

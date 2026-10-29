import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { selectedPacksProofSchema } from "./settings-domain-proof.contracts.ts";

const PROOF_URL = "/onboarding-skills-page-proof.html";
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const PACKS = [
	{
		description: "Code review and debugging workflows.",
		id: "fixture/engineering",
		name: "Engineering",
	},
	{
		description: "Research and synthesis workflows.",
		id: "fixture/research",
		name: "Research",
	},
	{
		description: "Clear writing and editing workflows.",
		id: "fixture/writing",
		name: "Writing",
	},
];
const CORS_HEADERS = {
	"access-control-allow-headers":
		"authorization,content-type,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-ryu-user-id,x-ryu-user-name,x-ryu-user-jwt",
	"access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
	"access-control-allow-origin": "*",
};

interface SkillRequest {
	authorization: string | null;
	body: { selectedPackIds: string[] } | null;
	method: string;
}

interface ApiCall {
	method: string;
	path: string;
}

interface FixtureOptions {
	failFirstGet?: boolean;
	failFirstPut?: boolean;
	selectedPackIds: string[];
}

async function installLocalApiFixture(page: Page, options: FixtureOptions) {
	const calls: SkillRequest[] = [];
	const apiCalls: ApiCall[] = [];
	let selectedPackIds = [...options.selectedPackIds];
	let getCount = 0;
	let putCount = 0;

	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}

		if (request.method() === "OPTIONS") {
			await route.fulfill({ headers: CORS_HEADERS, status: 204 });
			return;
		}
		apiCalls.push({ method: request.method(), path: url.pathname });

		if (url.pathname === "/api/onboarding/skills") {
			if (request.method() === "GET") {
				getCount += 1;
				calls.push({
					authorization: request.headers().authorization ?? null,
					body: null,
					method: "GET",
				});
				if (options.failFirstGet && getCount === 1) {
					await route.fulfill({
						body: JSON.stringify({ error: "Fixture catalog unavailable" }),
						contentType: "application/json",
						headers: CORS_HEADERS,
						status: 503,
					});
					return;
				}
				await route.fulfill({
					body: JSON.stringify({
						builtInNotice:
							"Built-in Ryu skills remain available with any selection.",
						canConfigure: true,
						configured: getCount > 1,
						options: PACKS,
						selectedPackIds,
					}),
					contentType: "application/json",
					headers: CORS_HEADERS,
					status: 200,
				});
				return;
			}

			if (request.method() === "PUT") {
				putCount += 1;
				const body = selectedPacksProofSchema.parse(request.postDataJSON());
				calls.push({
					authorization: request.headers().authorization ?? null,
					body,
					method: "PUT",
				});
				if (options.failFirstPut && putCount === 1) {
					await route.fulfill({
						body: JSON.stringify({ error: "Fixture save unavailable" }),
						contentType: "application/json",
						headers: CORS_HEADERS,
						status: 503,
					});
					return;
				}

				selectedPackIds = [...body.selectedPackIds];
				await route.fulfill({
					body: JSON.stringify({
						builtInNotice:
							"Built-in Ryu skills remain available with any selection.",
						canConfigure: true,
						configured: true,
						options: PACKS,
						selectedPackIds,
						syncComplete: true,
					}),
					contentType: "application/json",
					headers: CORS_HEADERS,
					status: 200,
				});
				return;
			}
		}

		await route.fulfill({
			body: "{}",
			contentType: "application/json",
			headers: CORS_HEADERS,
			status: 200,
		});
	});

	return { apiCalls, calls };
}

function installerApiCalls(apiCalls: ApiCall[]) {
	return apiCalls.filter(
		(call) =>
			call.path === "/api/catalog" ||
			call.path === "/api/dependencies/check" ||
			call.path.startsWith("/api/setup/")
	);
}

test.beforeAll(async () => {
	await mkdir(EVIDENCE_DIR, { recursive: true });
});

test("resumes the production skills step, saves exact choices, and advances", async ({
	page,
}) => {
	const fixture = await installLocalApiFixture(page, {
		selectedPackIds: ["fixture/engineering", "fixture/research"],
	});
	await page.goto(PROOF_URL);
	await expect(page.getByTestId("onboarding-skills-selected-count")).toHaveText(
		"2 of 3 selected"
	);
	await expect(
		page.getByTestId("onboarding-skill-pack-fixture-engineering")
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByTestId("onboarding-skill-pack-fixture-writing")
	).toHaveAttribute("aria-pressed", "false");

	await page.getByRole("button", { name: "Select all", exact: true }).click();
	await page.getByTestId("onboarding-skill-pack-fixture-research").click();
	await expect(page.getByTestId("onboarding-skills-selected-count")).toHaveText(
		"2 of 3 selected"
	);
	await page
		.getByRole("button", { name: "Install 2 packs & continue", exact: true })
		.click();

	await expect(
		page.getByRole("heading", { name: "Set your local default" })
	).toBeVisible();
	expect(fixture.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
	expect(fixture.calls[0]?.authorization).toBe("Bearer setup-proof-node-token");
	expect(fixture.calls[1]?.body).toEqual({
		selectedPackIds: ["fixture/engineering", "fixture/writing"],
	});
	expect(fixture.calls[1]?.authorization).toBe("Bearer setup-proof-node-token");
	expect(installerApiCalls(fixture.apiCalls)).toEqual([]);
});

test("shows a failed save, retries the node read, and lets the user continue", async ({
	page,
}) => {
	const fixture = await installLocalApiFixture(page, {
		failFirstPut: true,
		selectedPackIds: ["fixture/engineering"],
	});
	await page.goto(PROOF_URL);
	await expect(page.getByTestId("onboarding-skills-selected-count")).toHaveText(
		"1 of 3 selected"
	);
	await page.getByRole("button", { name: "Unselect all", exact: true }).click();
	await expect(page.getByTestId("onboarding-skills-selected-count")).toHaveText(
		"0 of 3 selected"
	);
	await page
		.getByRole("button", {
			name: "Continue with no optional packs",
			exact: true,
		})
		.click();

	const alert = page.getByRole("alert");
	await expect(alert).toContainText("/api/onboarding/skills failed: 503");
	await expect(
		page.getByRole("button", { name: "Retry", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(alert).toHaveCount(0);
	await expect(page.getByTestId("onboarding-skills-selected-count")).toHaveText(
		"1 of 3 selected"
	);
	await expect(
		page.getByTestId("onboarding-skill-pack-fixture-engineering")
	).toHaveAttribute("aria-pressed", "true");
	await page.screenshot({
		fullPage: true,
		path: path.join(
			EVIDENCE_DIR,
			"desktop-onboarding-skills-retry-readback.png"
		),
	});

	await page
		.getByRole("button", { name: "Install 1 pack & continue", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Set your local default" })
	).toBeVisible();
	expect(fixture.calls.map((call) => call.method)).toEqual([
		"GET",
		"PUT",
		"GET",
		"PUT",
	]);
	expect(fixture.calls[1]?.body).toEqual({ selectedPackIds: [] });
	expect(fixture.calls[3]?.body).toEqual({
		selectedPackIds: ["fixture/engineering"],
	});
	expect(
		fixture.calls.every(
			(call) =>
				call.method === "GET" ||
				call.authorization === "Bearer setup-proof-node-token"
		)
	).toBe(true);
	expect(installerApiCalls(fixture.apiCalls)).toEqual([]);
});

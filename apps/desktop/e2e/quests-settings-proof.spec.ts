import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const API_PATH = "/api/quests/detection-config";
const PROOF_ORIGIN = "http://127.0.0.1:5286";
const NODE_TOKEN = "quests-settings-proof-token";
const USER_JWT = "quests-settings-proof-user-jwt";
const DEFAULT_CONFIG: DetectionConfig = {
	effort: "",
	interval: "2m",
	mode: "auto_high",
	model: "",
};
// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
const EVIDENCE_DIR = process.env.RYU_PROOF_OUTPUT_ROOT
	? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT)
	: path.resolve(
			process.cwd(),
			"../../docs/proof/test-coverage-sweep-20260924/evidence"
		);

interface DetectionConfig {
	effort: string;
	interval: string;
	mode: "off" | "suggest" | "auto_high" | "auto_all";
	model: string;
}

interface CapturedRequest {
	authorization: string | null;
	body: Partial<DetectionConfig> | null;
	method: string;
	status: number;
	url: string;
	userJwt: string | null;
}

interface FixtureOptions {
	config?: DetectionConfig;
	getFailures?: number;
	putFailures?: number;
}

interface QuestsFixture {
	armPutFailure(): void;
	readConfig(): DetectionConfig;
	readonly requests: CapturedRequest[];
}

async function installFixture(
	page: Page,
	options: FixtureOptions = {}
): Promise<QuestsFixture> {
	let config = structuredClone(options.config ?? DEFAULT_CONFIG);
	let getFailures = options.getFailures ?? 0;
	let putFailures = options.putFailures ?? 0;
	const requests: CapturedRequest[] = [];

	await page.route(`${PROOF_ORIGIN}${API_PATH}`, async (route) => {
		const request = route.request();
		const method = request.method().toUpperCase();
		const body = request.postDataJSON();
		const record: CapturedRequest = {
			body,
			method,
			status: 0,
			url: new URL(request.url()).origin,
			authorization: request.headers().authorization ?? null,
			userJwt: request.headers()["x-ryu-user-jwt"] ?? null,
		};
		requests.push(record);

		if (method === "GET" && getFailures > 0) {
			getFailures--;
			record.status = 503;
			await route.fulfill({
				body: JSON.stringify({ error: "fixture offline" }),
				contentType: "application/json",
				status: 503,
			});
			return;
		}

		if (method === "PUT" && putFailures > 0) {
			putFailures--;
			record.status = 503;
			await route.fulfill({
				body: JSON.stringify({ error: "fixture offline" }),
				contentType: "application/json",
				status: 503,
			});
			return;
		}

		if (method === "PUT") {
			config = { ...config, ...body };
		}
		record.status = 200;
		await route.fulfill({
			body: JSON.stringify(config),
			contentType: "application/json",
			status: 200,
		});
	});

	return {
		requests,
		armPutFailure() {
			putFailures++;
		},
		readConfig() {
			return structuredClone(config);
		},
	};
}

async function openSettings(page: Page) {
	await page.goto("/quests-settings-proof.html");
	await expect(
		page.getByRole("heading", { name: "Auto-detection" })
	).toBeVisible();
}

function expectNodeScopedRequests(requests: CapturedRequest[]) {
	expect(requests.length).toBeGreaterThan(0);
	for (const request of requests) {
		expect(request.url).toBe(PROOF_ORIGIN);
		expect(request.authorization).toBe(`Bearer ${NODE_TOKEN}`);
		expect(request.userJwt).toBe(USER_JWT);
	}
}

test("recovers a failed node-scoped settings read with Retry", async ({
	page,
}) => {
	const fixture = await installFixture(page, { getFailures: 1 });
	await page.goto("/quests-settings-proof.html");
	await expect(
		page.getByText("Couldn't load quest settings").first()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-quests-settings-load-failed.png"),
	});

	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByRole("heading", { name: "Auto-detection" })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Detection mode" })
	).toHaveText(/Auto-complete \(high confidence\)/);
	await expect(page.getByRole("textbox", { name: "Model" })).toHaveValue("");
	await expect(
		page.getByRole("textbox", { name: "Check interval" })
	).toHaveValue("2m");
	expect(
		fixture.requests.map((request) => [request.method, request.status])
	).toEqual([
		["GET", 503],
		["GET", 200],
	]);
	expectNodeScopedRequests(fixture.requests);
	await expect(
		page.getByText("Couldn't load quest settings", { exact: true })
	).toHaveCount(0, { timeout: 10_000 });
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-quests-settings-load-recovered.png"),
	});
});

test("writes exact detection settings and reads the saved values after reload", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	await openSettings(page);

	const mode = page.getByRole("combobox", { name: "Detection mode" });
	for (const [label, value] of [
		["Off", "off"],
		["Suggest", "suggest"],
		["Auto-complete (always)", "auto_all"],
		["Auto-complete (high confidence) — default", "auto_high"],
	] as const) {
		await mode.click();
		await page.getByRole("option", { name: label, exact: true }).click();
		await expect.poll(() => fixture.readConfig().mode).toBe(value);
	}

	const model = page.getByRole("textbox", { name: "Model" });
	await model.fill("  local/quest-judge-v2  ");
	await model.press("Tab");
	await expect
		.poll(() => fixture.readConfig().model)
		.toBe("local/quest-judge-v2");

	const effort = page.getByRole("combobox", { name: "Reasoning effort" });
	await effort.click();
	await page.getByRole("option", { name: "High", exact: true }).click();
	await expect.poll(() => fixture.readConfig().effort).toBe("high");
	await effort.click();
	await page
		.getByRole("option", { name: "Provider default", exact: true })
		.click();
	await expect.poll(() => fixture.readConfig().effort).toBe("");
	await page.keyboard.press("Escape");
	await expect(effort).toHaveAttribute("aria-expanded", "false");

	const interval = page.getByRole("textbox", { name: "Check interval" });
	await interval.fill(" 1h 30m ");
	await interval.press("Tab");
	await expect.poll(() => fixture.readConfig().interval).toBe("1h 30m");

	expect(
		fixture.requests
			.filter((request) => request.method === "PUT")
			.map((request) => request.body)
	).toEqual([
		{ mode: "off" },
		{ mode: "suggest" },
		{ mode: "auto_all" },
		{ mode: "auto_high" },
		{ model: "local/quest-judge-v2" },
		{ effort: "high" },
		{ effort: "" },
		{ interval: "1h 30m" },
	]);
	expectNodeScopedRequests(fixture.requests);
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-quests-settings-persisted.png"),
	});

	await page.reload();
	await expect(mode).toHaveText(/Auto-complete \(high confidence\)/);
	await expect(model).toHaveValue("local/quest-judge-v2");
	await expect(effort).toHaveText(/Provider default/);
	await expect(interval).toHaveValue("1h 30m");
	expect(fixture.readConfig()).toEqual({
		effort: "",
		interval: "1h 30m",
		mode: "auto_high",
		model: "local/quest-judge-v2",
	});
});

test("rejects invalid intervals without a write, then retries a failed valid save", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	await openSettings(page);

	const interval = page.getByRole("textbox", { name: "Check interval" });
	await interval.fill("two minutes");
	await interval.press("Tab");
	await expect(
		page
			.getByRole("alert", { name: "" })
			.getByText("Enter a valid duration such as 30s, 2m, or 1h.")
	).toBeVisible();
	expect(
		fixture.requests.filter((request) => request.method === "PUT")
	).toEqual([]);
	expect(fixture.readConfig().interval).toBe("2m");
	await page.screenshot({
		fullPage: true,
		path: path.join(
			EVIDENCE_DIR,
			"desktop-quests-settings-invalid-interval.png"
		),
	});

	await interval.fill("30s");
	await interval.press("Tab");
	await expect.poll(() => fixture.readConfig().interval).toBe("30s");
	await expect(page.getByRole("alert")).toHaveCount(0);

	fixture.armPutFailure();
	const mode = page.getByRole("combobox", { name: "Detection mode" });
	await mode.click();
	await page.getByRole("option", { name: "Suggest", exact: true }).click();
	await expect(
		page.getByText("Couldn't save quest settings. Your change is still here.")
	).toBeVisible();
	await expect(mode).toHaveText(/^Suggest/);
	await expect(mode).toBeDisabled();
	await expect.poll(() => fixture.readConfig().mode).toBe("auto_high");

	await page.getByRole("button", { name: "Retry save" }).click();
	await expect.poll(() => fixture.readConfig().mode).toBe("suggest");
	await expect(
		page.getByText("Couldn't save quest settings. Your change is still here.")
	).toHaveCount(0);
	await expect(mode).toBeEnabled();
	expect(
		fixture.requests
			.filter((request) => request.method === "PUT")
			.map(({ body, status }) => ({ body, status }))
	).toEqual([
		{ body: { interval: "30s" }, status: 200 },
		{ body: { mode: "suggest" }, status: 503 },
		{ body: { mode: "suggest" }, status: 200 },
	]);
	expectNodeScopedRequests(fixture.requests);
	await page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-quests-settings-save-recovered.png"),
	});
});

import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/acp-runtime-settings-proof.html";
const CONTROL_HEADERS = { "x-acp-proof-control": "finite-acp-fixture" };
interface Settings {
	idle_timeout_minutes: number;
	max_parallel_agents: number | null;
	keep_computer_awake: boolean;
}
interface Call {
	method: "GET" | "PUT";
	path: string;
	authorization: string | null;
	contentType: string | null;
	body: { acp: Settings } | null;
	status: "pending" | "accepted" | "refused";
}
interface FixtureState {
	saved: Settings;
	calls: Call[];
	heldWrite: boolean;
	unexpected: { method: string; path: string; reason: string }[];
}
const INITIAL: Settings = {
	idle_timeout_minutes: 10,
	max_parallel_agents: null,
	keep_computer_awake: true,
};
async function control(
	page: Page,
	action: string,
	accept?: boolean
): Promise<void> {
	const response = await page.request.post("/__acp-proof/control", {
		headers: CONTROL_HEADERS,
		data: { action, ...(accept === undefined ? {} : { accept }) },
	});
	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ ok: true });
}
async function state(page: Page): Promise<FixtureState> {
	const response = await page.request.get("/__acp-proof/state", {
		headers: CONTROL_HEADERS,
	});
	expect(response.status()).toBe(200);
	return (await response.json()) as FixtureState;
}
async function writes(page: Page): Promise<Call[]> {
	return (await state(page)).calls.filter((call) => call.method === "PUT");
}
const idle = (page: Page) => page.getByLabel("ACP idle timeout in minutes");
const maximum = (page: Page) =>
	page.getByRole("combobox", { name: "Maximum parallel ACP agents" });
const awake = (page: Page) =>
	page.getByRole("switch", {
		name: "Keep this device awake while agents run",
	});
async function expectSettings(page: Page, expected: Settings): Promise<void> {
	await expect(idle(page)).toHaveValue(String(expected.idle_timeout_minutes));
	await expect(maximum(page).locator('[data-slot="select-value"]')).toHaveText(
		expected.max_parallel_agents === null
			? "Auto (2)"
			: String(expected.max_parallel_agents)
	);
	if (expected.keep_computer_awake) await expect(awake(page)).toBeChecked();
	else await expect(awake(page)).not.toBeChecked();
	await expect(
		page
			.getByTestId("acp-runtime-settings")
			.getByText(`1 active / ${expected.max_parallel_agents ?? 2} allowed`, {
				exact: true,
			})
	).toBeVisible();
}
async function expectAccepted(
	page: Page,
	expected: Settings,
	count: number
): Promise<void> {
	await expect.poll(async () => (await state(page)).saved).toEqual(expected);
	await expect.poll(async () => (await writes(page)).length).toBe(count);
	const ledger = await writes(page);
	expect(ledger.at(-1)).toEqual({
		method: "PUT",
		path: "/api/gateway/config",
		authorization: "Bearer acp-runtime-proof-node-token",
		contentType: "application/json",
		body: { acp: expected },
		status: "accepted",
	});
	await expect(idle(page)).toBeEnabled();
	await expectSettings(page, expected);
}
async function selectMaximum(page: Page, value: number | null): Promise<void> {
	await maximum(page).click();
	await page
		.getByRole("option", {
			name: value === null ? "Auto (2)" : String(value),
			exact: true,
		})
		.click();
}

test.beforeEach(async ({ page }) => {
	await control(page, "reset");
});
test.afterEach(async ({ page }) => {
	const snapshot = await state(page);
	if (snapshot.heldWrite) {
		await control(page, "release_write", false);
		await expect.poll(async () => (await state(page)).heldWrite).toBe(false);
	}
	expect((await state(page)).unexpected).toEqual([]);
});

test("ACP saves exact scalar policy for every parallel option and both awake states, then fresh-loads acknowledged values", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expectSettings(page, INITIAL);
	await expect(
		page.getByText("4 physical · 32 GiB RAM", { exact: true })
	).toBeVisible();
	expect((await state(page)).calls).toEqual([
		{
			method: "GET",
			path: "/api/gateway/config",
			authorization: "Bearer acp-runtime-proof-node-token",
			contentType: "application/json",
			body: null,
			status: "accepted",
		},
	]);
	let expected: Settings = { ...INITIAL, idle_timeout_minutes: 15 };
	await idle(page).fill("15");
	await idle(page).press("Enter");
	await expectAccepted(page, expected, 1);
	let count = 1;
	for (const limit of [1, 2, 4, 8, 16, 32, null]) {
		await selectMaximum(page, limit);
		expected = { ...expected, max_parallel_agents: limit };
		await expectAccepted(page, expected, ++count);
	}
	for (const keepAwake of [false, true, false]) {
		await awake(page).click();
		expected = { ...expected, keep_computer_awake: keepAwake };
		await expectAccepted(page, expected, ++count);
	}
	const beforeReload = await writes(page);
	await page.reload();
	await expectSettings(page, expected);
	expect((await state(page)).saved).toEqual(expected);
	expect(await writes(page)).toEqual(beforeReload);
	expect(
		(await state(page)).calls.filter((call) => call.method === "GET").at(-1)
			?.status
	).toBe("accepted");
});

const refusals = [
	{
		name: "idle timeout",
		desired: { ...INITIAL, idle_timeout_minutes: 30 },
		change: async (page: Page) => {
			await idle(page).fill("30");
			await idle(page).press("Enter");
		},
	},
	{
		name: "maximum parallel agents",
		desired: { ...INITIAL, max_parallel_agents: 8 },
		change: async (page: Page) => {
			await selectMaximum(page, 8);
		},
	},
	{
		name: "keep awake",
		desired: { ...INITIAL, keep_computer_awake: false },
		change: async (page: Page) => {
			await awake(page).click();
		},
	},
];
for (const scenario of refusals) {
	test(`ACP ${scenario.name} pending write blocks duplicates, refusal retains stored policy, and explicit identical retry survives remount`, async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expectSettings(page, INITIAL);
		await control(page, "hold_next_write");
		await scenario.change(page);
		await expect.poll(async () => (await state(page)).heldWrite).toBe(true);
		await expect(idle(page)).toBeDisabled();
		await expect(maximum(page)).toBeDisabled();
		await expect(awake(page)).toBeDisabled();
		expect((await state(page)).saved).toEqual(INITIAL);
		const pending = await writes(page);
		expect(pending).toEqual([
			{
				method: "PUT",
				path: "/api/gateway/config",
				authorization: "Bearer acp-runtime-proof-node-token",
				contentType: "application/json",
				body: { acp: scenario.desired },
				status: "pending",
			},
		]);
		// Native pointer/keyboard actions while the real controls are disabled.
		const bounds = await awake(page).boundingBox();
		if (!bounds) throw new Error("Pending keep-awake control is missing.");
		await page.mouse.click(
			bounds.x + bounds.width / 2,
			bounds.y + bounds.height / 2
		);
		await page.keyboard.press("Enter");
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
		);
		expect(await writes(page)).toEqual(pending);
		await control(page, "release_write", false);
		await expect(
			page.getByText("Could not save ACP runtime settings", { exact: true })
		).toBeVisible();
		await expect(
			page.getByText("/api/gateway/config failed: 503", { exact: true })
		).toBeVisible();
		await expect(idle(page)).toBeEnabled();
		await expect(page.getByRole("listbox")).toHaveCount(0);
		const refused = await writes(page);
		expect(refused).toEqual([{ ...pending[0], status: "refused" }]);
		expect((await state(page)).saved).toEqual(INITIAL);
		await page.reload();
		await expectSettings(page, INITIAL);
		expect((await state(page)).saved).toEqual(INITIAL);
		expect(await writes(page)).toEqual(refused);
		await scenario.change(page);
		await expectAccepted(page, scenario.desired, 2);
		expect((await writes(page))[1]?.body).toEqual(refused[0]?.body);
		const accepted = await writes(page);
		await page.reload();
		await expectSettings(page, scenario.desired);
		expect((await state(page)).saved).toEqual(scenario.desired);
		expect(await writes(page)).toEqual(accepted);
	});
}

test("ACP idle bounds persist clamped values while fractional and unchanged drafts produce no write", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expectSettings(page, INITIAL);
	await idle(page).fill("0");
	await idle(page).press("Enter");
	await expectAccepted(page, { ...INITIAL, idle_timeout_minutes: 1 }, 1);
	await idle(page).fill("1441");
	await idle(page).press("Enter");
	const bounded = { ...INITIAL, idle_timeout_minutes: 1440 };
	await expectAccepted(page, bounded, 2);
	const before = await writes(page);
	await idle(page).fill("2.5");
	await idle(page).press("Enter");
	await expect(idle(page)).toHaveValue("1440");
	expect((await state(page)).saved).toEqual(bounded);
	expect(await writes(page)).toEqual(before);
	await idle(page).fill("1440");
	await idle(page).press("Enter");
	expect(await writes(page)).toEqual(before);
	await page.reload();
	await expectSettings(page, bounded);
	expect((await state(page)).saved).toEqual(bounded);
	expect(await writes(page)).toEqual(before);
});

test("ACP refused initial read disables writes until its visible Retry fetches the persisted policy", async ({
	page,
}) => {
	await control(page, "refuse_next_read");
	await page.goto(STORY_URL);
	await expect(page.getByRole("alert")).toHaveText(
		"Could not load ACP runtime settings."
	);
	await expect(idle(page)).toBeDisabled();
	await expect(maximum(page)).toBeDisabled();
	await expect(awake(page)).toBeDisabled();
	expect((await state(page)).saved).toEqual(INITIAL);
	expect(await writes(page)).toEqual([]);
	expect((await state(page)).calls.map((call) => call.status)).toEqual([
		"refused",
	]);
	await page
		.getByRole("button", { name: "Retry ACP runtime settings", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expectSettings(page, INITIAL);
	await expect(idle(page)).toBeEnabled();
	expect((await state(page)).calls).toEqual(
		["refused", "accepted"].map((status) => ({
			method: "GET",
			path: "/api/gateway/config",
			authorization: "Bearer acp-runtime-proof-node-token",
			contentType: "application/json",
			body: null,
			status,
		}))
	);
	expect(await writes(page)).toEqual([]);
});

test("ACP viewer sees persisted policy and runtime projection but cannot emit settings writes", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?viewer=1`);
	await expectSettings(page, INITIAL);
	await expect(idle(page)).toBeDisabled();
	await expect(maximum(page)).toBeDisabled();
	await expect(awake(page)).toBeDisabled();
	expect((await state(page)).saved).toEqual(INITIAL);
	expect(await writes(page)).toEqual([]);
});

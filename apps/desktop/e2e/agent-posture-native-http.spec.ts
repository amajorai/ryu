import { expect, type Page, test } from "@playwright/test";

const CORE = "http://127.0.0.1:5731";
const PATH = "/api/agents/version-proof";
interface Call {
	authorization: string | null;
	body: unknown;
	id: number;
	jwt: string | null;
	method: string;
	path: string;
	scope: "a" | "b" | null;
	status: number | null;
}
interface Agent {
	lifecycle_status: string;
	name: string;
	safety_profile: string;
	skills: string[];
	system_prompt: string;
	tools: string[];
}
interface State {
	calls: Call[];
	held: number[];
	records: { a: Agent; b: Agent };
	unexpected: Call[];
}
async function state(page: Page): Promise<State> {
	const response = await page.request.get(`${CORE}/__state`);
	expect(response.status()).toBe(200);
	return response.json();
}
async function control(page: Page, body: unknown) {
	const response = await page.request.post(`${CORE}/__control`, {
		headers: { "x-proof-control": "owned-posture-proof" },
		data: body,
	});
	expect(response.status()).toBe(200);
}
const writes = (snapshot: State) =>
	snapshot.calls.filter((call) => call.path === PATH && call.method === "PUT");
async function boot(page: Page) {
	await page.goto("/agent-posture-native-http.html");
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Current agent"
	);
	await page
		.getByRole("tab", { name: "Tools & knowledge", exact: true })
		.click();
	await expect(page.getByLabel("Agent lifecycle")).toHaveValue("active");
}
async function switchTo(page: Page, scope: "a" | "b") {
	await page
		.getByRole("button", {
			name: `Use scope ${scope.toUpperCase()}`,
			exact: true,
		})
		.click();
	await page.getByRole("tab", { name: "Behavior", exact: true }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		scope === "a" ? "Current agent" : "Scope B agent"
	);
	const tab = page.getByRole("tab", { name: "Tools & knowledge", exact: true });
	if (!(await page.getByLabel("Agent lifecycle").isVisible())) {
		await tab.click();
	}
	await expect(page.getByLabel("Agent lifecycle")).toHaveValue(
		scope === "a" ? "active" : "trial"
	);
}
async function independentRead(page: Page, scope: "a" | "b"): Promise<Agent> {
	const response = await page.request.get(`${CORE}/scope-${scope}${PATH}`, {
		headers: {
			authorization: `Bearer version-bearer-${scope}`,
			"x-ryu-user-jwt": `version-user-${scope}`,
		},
	});
	expect(response.status()).toBe(200);
	return (await response.json()).agent;
}
async function consumedResponse(
	page: Page,
	response: Promise<import("@playwright/test").Response>
) {
	await (await response).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
}
let errors: string[] = [];
test.beforeEach(async ({ page }) => {
	errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await control(page, { action: "reset" });
});
test.afterEach(async ({ page }) => {
	const snapshot = await state(page);
	for (const id of snapshot.held) {
		await control(page, { action: "release", id });
	}
	expect(snapshot.unexpected).toEqual([]);
	expect(errors).toEqual([]);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__postureProofNativeUnexpected")
		)
	).toEqual([]);
});
for (const field of ["lifecycle_status", "safety_profile"] as const) {
	const label =
		field === "lifecycle_status" ? "Agent lifecycle" : "Agent safety profile";
	const saved = field === "lifecycle_status" ? "active" : "approval_required";
	const wanted = field === "lifecycle_status" ? "trial" : "verified_plan_only";
	test(`actual editor sparse ${field} PUT preserves hidden fields and fresh GET/remount`, async ({
		page,
	}) => {
		await boot(page);
		const before = await independentRead(page, "a");
		await page.getByLabel(label).selectOption(wanted);
		await expect
			.poll(async () =>
				writes(await state(page)).map((call) => ({
					scope: call.scope,
					body: call.body,
					status: call.status,
					authorization: call.authorization,
					jwt: call.jwt,
				}))
			)
			.toEqual([
				{
					scope: "a",
					body: { [field]: wanted },
					status: 200,
					authorization: "Bearer version-bearer-a",
					jwt: "version-user-a",
				},
			]);
		expect(await independentRead(page, "a")).toEqual({
			...before,
			[field]: wanted,
		});
		await page.reload();
		await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
			"Current agent"
		);
		await page
			.getByRole("tab", { name: "Tools & knowledge", exact: true })
			.click();
		await expect(page.getByLabel(label)).toHaveValue(wanted);
		expect(writes(await state(page))).toHaveLength(1);
	});
	test(`actual editor refused ${field} remains unsaved and supports identical user retry`, async ({
		page,
	}) => {
		await boot(page);
		const before = await independentRead(page, "a");
		await control(page, { action: "next", hold: false, status: 403 });
		await page.getByLabel(label).selectOption(wanted);
		await expect(
			page.getByText(`${PATH} failed: 403`, { exact: true })
		).toBeVisible();
		expect(await independentRead(page, "a")).toEqual(before);
		// A real retry action or acknowledged-value rollback is required. Re-selecting
		// the already-selected native value would manufacture a browser change event.
		const retry = page.getByRole("button", { name: /retry/i });
		if (await retry.isVisible()) {
			await retry.click();
		} else {
			await expect(page.getByLabel(label)).toHaveValue(saved);
			await page.getByLabel(label).selectOption(wanted);
		}
		await expect
			.poll(async () =>
				writes(await state(page)).map((call) => ({
					body: call.body,
					status: call.status,
				}))
			)
			.toEqual([
				{ body: { [field]: wanted }, status: 403 },
				{ body: { [field]: wanted }, status: 200 },
			]);
		expect(await independentRead(page, "a")).toEqual({
			...before,
			[field]: wanted,
		});
		await expect(
			page.getByText(`${PATH} failed: 403`, { exact: true })
		).toHaveCount(0);
		await page.reload();
		await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
			"Current agent"
		);
		await page
			.getByRole("tab", { name: "Tools & knowledge", exact: true })
			.click();
		await expect(page.getByLabel(label)).toHaveValue(wanted);
	});
}
for (const status of [200, 403] as const) {
	for (const returnToA of [false, true]) {
		test(`held A posture ${status} after ${returnToA ? "A→B→A" : "A→B"} cannot publish into the current editor`, async ({
			page,
		}) => {
			await boot(page);
			const original = await independentRead(page, "a");
			await control(page, { action: "next", hold: true, status });
			await page.getByLabel("Agent safety profile").selectOption("autonomous");
			await expect.poll(async () => (await state(page)).held.length).toBe(1);
			await expect(page.getByLabel("Agent lifecycle")).toBeDisabled();
			await expect(page.getByLabel("Agent safety profile")).toBeDisabled();
			const pending = (await state(page)).held[0];
			expect(pending).toBeDefined();
			await switchTo(page, "b");
			await expect(page.getByLabel("Agent safety profile")).toHaveValue(
				"read_only"
			);
			await expect(page.getByLabel("Agent safety profile")).toBeEnabled();
			if (returnToA) {
				await switchTo(page, "a");
				await expect(page.getByLabel("Agent safety profile")).toHaveValue(
					"approval_required"
				);
			}
			if (returnToA) {
				await expect(page.getByLabel("Agent safety profile")).toBeDisabled();
				await expect(page.getByLabel("Agent lifecycle")).toBeDisabled();
			}
			const readsBeforeAck = (await state(page)).calls.filter(
				(call) =>
					call.scope === "a" && call.method === "GET" && call.path === PATH
			).length;
			const response = page.waitForResponse(
				(res) =>
					res.request().method() === "PUT" &&
					new URL(res.url()).pathname === `/scope-a${PATH}`
			);
			await control(page, { action: "release", id: pending });
			await consumedResponse(page, response);
			if (returnToA) {
				// Independent readback below must not satisfy the shipping reconciliation oracle.
				await expect
					.poll(
						async () =>
							(await state(page)).calls.filter(
								(call) =>
									call.scope === "a" &&
									call.method === "GET" &&
									call.path === PATH &&
									call.authorization === "Bearer version-bearer-a" &&
									call.jwt === "version-user-a" &&
									call.status === 200
							).length
					)
					.toBeGreaterThan(readsBeforeAck);
			}
			await expect(page.getByLabel("Agent safety profile")).toHaveValue(
				returnToA
					? status === 200
						? "autonomous"
						: "approval_required"
					: "read_only"
			);
			if (returnToA) {
				await expect(page.getByLabel("Agent safety profile")).toBeEnabled();
			}
			await expect(page.getByLabel("Agent lifecycle")).toHaveValue(
				returnToA ? "active" : "trial"
			);
			await expect(
				page.getByText(`${PATH} failed: 403`, { exact: true })
			).toHaveCount(0);
			const snapshot = await state(page);
			expect(
				writes(snapshot).map((call) => ({
					scope: call.scope,
					body: call.body,
					status: call.status,
				}))
			).toEqual([
				{ scope: "a", body: { safety_profile: "autonomous" }, status },
			]);
			expect(await independentRead(page, "a")).toEqual(
				status === 200
					? { ...original, safety_profile: "autonomous" }
					: original
			);
			expect(await independentRead(page, "b")).toEqual(snapshot.records.b);
		});
	}
}

for (const status of [200, 403] as const) {
	test(`SDK-equivalent same node alias waits for posture${status} acknowledgment and reads the physical saved agent`, async ({
		page,
	}) => {
		await boot(page);
		const original = await independentRead(page, "a");
		await control(page, { action: "next", hold: true, status });
		await page.getByLabel("Agent safety profile").selectOption("autonomous");
		await expect.poll(async () => (await state(page)).held.length).toBe(1);
		const pending = (await state(page)).held[0];
		expect(pending).toBeDefined();
		const aliasRead = page.waitForResponse(
			(response) =>
				response.request().method() === "GET" &&
				new URL(response.url()).pathname === `/scope-a${PATH}`
		);
		await page
			.getByRole("button", { name: "Use same node address alias", exact: true })
			.click();
		await consumedResponse(page, aliasRead);
		await page
			.getByRole("tab", { name: "Tools & knowledge", exact: true })
			.click();
		await expect(page.getByLabel("Agent safety profile")).toBeDisabled();
		await expect(page.getByLabel("Agent lifecycle")).toBeDisabled();
		expect(writes(await state(page))).toHaveLength(1);
		const readsBeforeAck = (await state(page)).calls.filter(
			(call) =>
				call.scope === "a" && call.method === "GET" && call.path === PATH
		).length;
		const response = page.waitForResponse(
			(res) =>
				res.request().method() === "PUT" &&
				new URL(res.url()).pathname === `/scope-a${PATH}`
		);
		await control(page, { action: "release", id: pending });
		await consumedResponse(page, response);
		await expect
			.poll(
				async () =>
					(await state(page)).calls.filter(
						(call) =>
							call.scope === "a" &&
							call.method === "GET" &&
							call.path === PATH &&
							call.authorization === "Bearer version-bearer-a" &&
							call.jwt === "version-user-a" &&
							call.status === 200
					).length
			)
			.toBeGreaterThan(readsBeforeAck);
		await expect(page.getByLabel("Agent safety profile")).toHaveValue(
			status === 200 ? "autonomous" : "approval_required"
		);
		await expect(page.getByLabel("Agent lifecycle")).toHaveValue("active");
		await expect(page.getByLabel("Agent safety profile")).toBeEnabled();
		await expect(
			page.getByText(`${PATH} failed: 403`, { exact: true })
		).toHaveCount(0);
		expect(
			writes(await state(page)).map((call) => ({
				scope: call.scope,
				body: call.body,
				status: call.status,
				authorization: call.authorization,
				jwt: call.jwt,
			}))
		).toEqual([
			{
				scope: "a",
				body: { safety_profile: "autonomous" },
				status,
				authorization: "Bearer version-bearer-a",
				jwt: "version-user-a",
			},
		]);
		expect(await independentRead(page, "a")).toEqual(
			status === 200 ? { ...original, safety_profile: "autonomous" } : original
		);
		const targetValue = status === 200 ? "autonomous" : "approval_required";
		await page.reload();
		await page
			.getByRole("tab", { name: "Tools & knowledge", exact: true })
			.click();
		await expect(page.getByLabel("Agent safety profile")).toHaveValue(
			targetValue
		);
	});
}

test("retired accepted posture requires a successful current read before retry admission", async ({
	page,
}) => {
	await boot(page);
	await control(page, { action: "next", hold: true, status: 200 });
	await page.getByLabel("Agent safety profile").selectOption("autonomous");
	await expect.poll(async () => (await state(page)).held.length).toBe(1);
	const pending = (await state(page)).held[0];
	expect(pending).toBeDefined();
	const aliasRead = page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			new URL(response.url()).pathname === `/scope-a${PATH}`
	);
	await page
		.getByRole("button", { name: "Use same node address alias", exact: true })
		.click();
	await consumedResponse(page, aliasRead);
	await page.getByRole("tab", { name: "Behavior", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("Unrelated unsaved name");
	await page
		.getByRole("tab", { name: "Tools & knowledge", exact: true })
		.click();
	await control(page, { action: "refuse-next-read", scope: "a" });
	const acknowledgment = page.waitForResponse(
		(response) =>
			response.request().method() === "PUT" &&
			new URL(response.url()).pathname === `/scope-a${PATH}`
	);
	await control(page, { action: "release", id: pending });
	await consumedResponse(page, acknowledgment);
	await expect
		.poll(async () =>
			(await state(page)).calls
				.filter(
					(call) =>
						call.method === "GET" && call.path === PATH && call.status === 403
				)
				.map((call) => ({
					scope: call.scope,
					authorization: call.authorization,
					jwt: call.jwt,
				}))
		)
		.toEqual([
			{
				scope: "a",
				authorization: "Bearer version-bearer-a",
				jwt: "version-user-a",
			},
		]);
	await expect(
		page.getByText(`${PATH} failed: 403`, { exact: true }).first()
	).toBeVisible();
	await expect(page.getByLabel("Agent lifecycle")).toBeDisabled();
	await expect(page.getByLabel("Agent safety profile")).toBeDisabled();
	const savedAfterAcknowledgment = await independentRead(page, "a");
	expect(savedAfterAcknowledgment.safety_profile).toBe("autonomous");
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true })
	).toBeDisabled();
	expect(writes(await state(page))).toHaveLength(1);
	const beforeRetry = (await state(page)).calls.length;
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByLabel("Agent safety profile")).toHaveValue(
		"autonomous"
	);
	await expect(page.getByLabel("Agent safety profile")).toBeEnabled();
	await expect(page.getByLabel("Agent lifecycle")).toHaveValue("active");
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true })
	).toBeEnabled();
	await expect
		.poll(async () =>
			(await state(page)).calls
				.slice(beforeRetry)
				.filter(
					(call) =>
						call.method === "GET" && call.path === PATH && call.status === 200
				)
				.map((call) => ({
					scope: call.scope,
					authorization: call.authorization,
					jwt: call.jwt,
				}))
		)
		.toEqual([
			{
				scope: "a",
				authorization: "Bearer version-bearer-a",
				jwt: "version-user-a",
			},
		]);
	expect(await independentRead(page, "a")).toEqual(savedAfterAcknowledgment);
	expect(
		writes(await state(page)).map((call) => ({
			body: call.body,
			status: call.status,
		}))
	).toEqual([{ body: { safety_profile: "autonomous" }, status: 200 }]);
	await page.getByRole("tab", { name: "Behavior", exact: true }).click();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Unrelated unsaved name"
	);
});

test("held genuine full agent Save owns the same physical policy barrier across an address alias", async ({
	page,
}) => {
	await boot(page);
	const original = await independentRead(page, "a");
	await page.getByRole("tab", { name: "Behavior", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("Full save durable name");
	await control(page, { action: "next", hold: true, status: 200 });
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect.poll(async () => (await state(page)).held.length).toBe(1);
	const pending = (await state(page)).held[0];
	expect(pending).toBeDefined();
	const full = writes(await state(page));
	expect(full).toHaveLength(1);
	expect(full[0]?.body).toMatchObject({
		name: "Full save durable name",
		safety_profile: "approval_required",
		system_prompt: "Current instructions.",
		engine: "acp:pi",
	});
	expect(await independentRead(page, "a")).toEqual(original);
	await page
		.getByRole("tab", { name: "Tools & knowledge", exact: true })
		.click();
	await expect(page.getByLabel("Agent safety profile")).toBeDisabled();
	await expect(page.getByLabel("Agent lifecycle")).toBeDisabled();
	const aliasRead = page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			new URL(response.url()).pathname === `/scope-a${PATH}`
	);
	await page
		.getByRole("button", { name: "Use same node address alias", exact: true })
		.click();
	await consumedResponse(page, aliasRead);
	await page
		.getByRole("tab", { name: "Tools & knowledge", exact: true })
		.click();
	await expect(page.getByLabel("Agent safety profile")).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true })
	).toBeDisabled();
	expect(writes(await state(page))).toHaveLength(1);
	const readsBefore = (await state(page)).calls.filter(
		(call) => call.method === "GET" && call.path === PATH
	).length;
	const ack = page.waitForResponse(
		(response) =>
			response.request().method() === "PUT" &&
			new URL(response.url()).pathname === `/scope-a${PATH}`
	);
	await control(page, { action: "release", id: pending });
	await consumedResponse(page, ack);
	await expect
		.poll(
			async () =>
				(await state(page)).calls.filter(
					(call) =>
						call.method === "GET" && call.path === PATH && call.status === 200
				).length
		)
		.toBeGreaterThan(readsBefore);
	await expect(page.getByLabel("Agent safety profile")).toBeEnabled();
	await expect(page.getByLabel("Agent safety profile")).toHaveValue(
		"approval_required"
	);
	const saved = await independentRead(page, "a");
	expect(saved.name).toBe("Full save durable name");
	expect(saved.safety_profile).toBe("approval_required");
	await page.getByLabel("Agent safety profile").selectOption("autonomous");
	await expect(page.getByLabel("Agent safety profile")).toHaveValue(
		"autonomous"
	);
	expect(await independentRead(page, "a")).toEqual({
		...saved,
		safety_profile: "autonomous",
	});
	expect(
		writes(await state(page)).map((call) => ({
			body: call.body,
			status: call.status,
			authorization: call.authorization,
			jwt: call.jwt,
		}))
	).toEqual([
		{
			body: full[0]?.body,
			status: 200,
			authorization: "Bearer version-bearer-a",
			jwt: "version-user-a",
		},
		{
			body: { safety_profile: "autonomous" },
			status: 200,
			authorization: "Bearer version-bearer-a",
			jwt: "version-user-a",
		},
	]);
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Full save durable name"
	);
	await page
		.getByRole("tab", { name: "Tools & knowledge", exact: true })
		.click();
	await expect(page.getByLabel("Agent safety profile")).toHaveValue(
		"autonomous"
	);
});

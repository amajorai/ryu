import { expect, test } from "@playwright/test";
const pageErrors = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page, request }, testInfo) => {
	if (testInfo.title.startsWith("authority:")) {
		const proof = await authorityState(request);
		await testInfo.attach("model-insight-authority-before-cleanup", {
			body: JSON.stringify(proof, null, 2),
			contentType: "application/json",
		});
		for (const id of proof.held) {
			await authorityControl(request, { action: "release", id });
		}
		await expect
			.poll(async () => {
				const current = await authorityState(request);
				return {
					held: current.held,
					complete: current.calls.every((call) => call.status === "accepted"),
					unexpected: current.unexpected,
				};
			})
			.toEqual({ held: [], complete: true, unexpected: [] });
	}
	const state = await (
		await request.get("http://127.0.0.1:5611/__proof/state")
	).json();
	if (state.heldRefused) {
		await request.post("http://127.0.0.1:5611/__proof/release-refused", {
			headers: { "x-insight-proof-control": "owned-local-fixture" },
		});
	}
	expect(state.unexpected).toEqual([]);
	expect(pageErrors.get(page)).toEqual([]);
});
for (const variant of ["paid", "free", "missing", "refused"] as const) {
	test(`shipping model hover reads exact insight and handles ${variant} pricing`, async ({
		page,
		request,
	}) => {
		const before = await (
			await request.get("http://127.0.0.1:5611/__proof/state")
		).json();
		await page.goto(`/model-insight-native-http.html?variant=${variant}`);
		await page
			.getByRole("button", { name: "Choose model", exact: true })
			.click();
		await page
			.getByRole("menuitem", { name: `Model ${variant}`, exact: true })
			.hover();
		await expect
			.poll(async () => {
				const state = await (
					await request.get("http://127.0.0.1:5611/__proof/state")
				).json();
				return state.calls.slice(before.calls.length);
			})
			.toEqual([
				{
					method: "GET",
					path: `/api/models/insight?model=openrouter%2F${variant}&provider=openrouter`,
					authorization: "Bearer model-insight-owned-token",
					userJwt: null,
					status: variant === "refused" ? 503 : 200,
				},
			]);
		if (variant === "refused") {
			await expect(page.locator(".animate-skeleton").first()).toBeVisible();
			const response = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/models/insight" &&
					response.status() === 503
			);
			expect(
				(
					await request.post("http://127.0.0.1:5611/__proof/release-refused", {
						headers: { "x-insight-proof-control": "owned-local-fixture" },
					})
				).ok()
			).toBe(true);
			await response;
			await expect(page.locator(".animate-skeleton")).toHaveCount(0);

			await expect(
				page.getByText(`Insight ${variant}`, { exact: true })
			).toHaveCount(0);
			await expect(
				page.getByText("Current OpenRouter transaction price", { exact: true })
			).toHaveCount(0);
			await expect(
				page.getByRole("menuitem", { name: `Model ${variant}`, exact: true })
			).toBeVisible();
		} else {
			await expect(
				page.getByText(`Insight ${variant}`, { exact: true })
			).toBeVisible();
			await expect(
				page.getByText("Current OpenRouter transaction price", { exact: true })
			).toBeVisible();
			if (variant === "missing") {
				await expect(page.getByText(/^In \$/)).toHaveCount(0);
				await expect(page.getByText(/^Out \$/)).toHaveCount(0);
			} else {
				await expect(
					page.getByText(
						variant === "free"
							? "In $0.0000 /1M · Out $0.0000 /1M"
							: "In $2.50 /1M · Out $15.00 /1M",
						{ exact: true }
					)
				).toBeVisible();
			}
		}
	});
}

// Actual shipping menu + SDK. Store updates represent real node/delegation
// refreshes; no alternate hover component or insight state setter is used.
async function authorityState(
	request: import("@playwright/test").APIRequestContext
) {
	const response = await request.get("http://127.0.0.1:5611/__authority/state");
	expect(response.status()).toBe(200);
	return (await response.json()) as {
		calls: {
			id: number;
			source: "A" | "B";
			path: string;
			authorization: string;
			userJwt: string;
			status: string;
			insight: Record<string, unknown>;
		}[];
		unexpected: string[];
		held: number[];
	};
}
async function authorityControl(
	request: import("@playwright/test").APIRequestContext,
	body: Record<string, unknown>
) {
	const response = await request.post(
		"http://127.0.0.1:5611/__authority/control",
		{
			headers: { "x-insight-proof-control": "owned-local-fixture" },
			data: body,
		}
	);
	expect(response.status()).toBe(200);
}
async function authorityOpen(
	page: import("@playwright/test").Page,
	request: import("@playwright/test").APIRequestContext
) {
	await authorityControl(request, { action: "reset" });
	await page.goto("/model-insight-native-http.html?variant=authority");
	await page.getByRole("button", { name: "Choose model", exact: true }).click();
}
async function authorityHover(page: import("@playwright/test").Page) {
	await page
		.getByRole("menuitem", { name: "Shared model", exact: true })
		.hover();
}
async function authorityLeave(page: import("@playwright/test").Page) {
	await page
		.getByRole("textbox", { name: "Filter models", exact: true })
		.hover();
	await expect(page.getByText(/^Insight (A|B|returned A)$/)).toHaveCount(0);
}
async function authorityRotate(
	page: import("@playwright/test").Page,
	dimension: "url" | "token" | "jwt" | "A"
) {
	await page.evaluate((dimension) => {
		const store = Reflect.get(window, "__modelInsightAuthorityStore");
		if (!store) throw Error("Actual NodeStore not available");
		store.setState(
			(state: { nodes: import("../src/store/useNodeStore.ts").Node[] }) => ({
				nodes: state.nodes.map((node) => ({
					...node,
					url:
						dimension === "url"
							? "http://127.0.0.1:5611/b"
							: "http://127.0.0.1:5611/a",
					token: dimension === "token" ? "insight-node-b" : "insight-node-a",
					userJwt: dimension === "jwt" ? "insight-user-b" : "insight-user-a",
				})),
			})
		);
	}, dimension);
}
async function authorityConsumed(
	page: import("@playwright/test").Page,
	count: number
) {
	await expect
		.poll(async () =>
			page.evaluate(
				() => Reflect.get(window, "__modelInsightConsumed")?.length ?? 0
			)
		)
		.toBe(count);
}
async function assertCurrentInsight(
	page: import("@playwright/test").Page,
	source: "A" | "B" | "returned A"
) {
	await expect(
		page.getByText("Insight " + source, { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			source === "B"
				? "Current B registry"
				: source === "A"
					? "Original A registry"
					: "Current returned A registry",
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page.getByText(
			`In $${source === "B" ? "9.00" : source === "A" ? "1.00" : "3.00"} /1M · Out $${source === "B" ? "18.00" : source === "A" ? "2.00" : "6.00"} /1M`,
			{ exact: true }
		)
	).toBeVisible();
	await expect(
		page.getByText(
			source === "B"
				? "via models.dev"
				: "Current OpenRouter transaction price",
			{ exact: true }
		)
	).toBeVisible();
}
test.afterEach(async ({ request }) => {
	const state = await authorityState(request);
	for (const id of state.held)
		await authorityControl(request, { action: "release", id });
	expect(state.unexpected).toEqual([]);
});
test("authority: unchanged source rehover retains decoded pricing cache without extra HTTP", async ({
	page,
	request,
}) => {
	await authorityOpen(page, request);
	await authorityHover(page);
	await assertCurrentInsight(page, "A");
	await authorityConsumed(page, 1);
	await authorityLeave(page);
	await authorityRotate(page, "A");
	await authorityHover(page);
	await assertCurrentInsight(page, "A");
	expect((await authorityState(request)).calls).toHaveLength(1);
});
for (const dimension of ["url", "token", "jwt"] as const)
	test(`authority: warmed same-model cache must read current ${dimension} source`, async ({
		page,
		request,
	}) => {
		await authorityOpen(page, request);
		await authorityHover(page);
		await assertCurrentInsight(page, "A");
		await authorityConsumed(page, 1);
		await authorityLeave(page);
		await authorityRotate(page, dimension);
		await authorityHover(page);
		await assertCurrentInsight(page, "B");
		await authorityConsumed(page, 2);
		const state = await authorityState(request);
		expect(state.calls).toHaveLength(2);
		expect(state.calls[1]).toMatchObject({
			path: `/${dimension === "url" ? "b" : "a"}/api/models/insight?model=openrouter%2Fshared&provider=openrouter`,
			authorization:
				"Bearer " +
				(dimension === "token" ? "insight-node-b" : "insight-node-a"),
			userJwt: dimension === "jwt" ? "insight-user-b" : "insight-user-a",
			insight: {
				id: "openrouter/shared",
				aaKeyPresent: true,
				source: "models.dev",
				costInputPer1m: 9,
				costOutputPer1m: 18,
				modalitiesInput: ["text", "image"],
			},
		});
		await expect(page.getByText("Insight A", { exact: true })).toHaveCount(0);
	});
test("authority: consumed retired response cannot poison current B rehover cache", async ({
	page,
	request,
}) => {
	await authorityOpen(page, request);
	await authorityControl(request, { action: "hold_next", source: "A" });
	await authorityHover(page);
	await expect
		.poll(async () => (await authorityState(request)).held.length)
		.toBe(1);
	const id = (await authorityState(request)).held[0];
	if (id === undefined) throw Error("Actual A request not held");
	await page
		.getByRole("textbox", { name: "Filter models", exact: true })
		.hover();
	await authorityRotate(page, "jwt");
	await authorityHover(page);
	await assertCurrentInsight(page, "B");
	await authorityControl(request, { action: "release", id });
	await authorityConsumed(page, 2);
	await assertCurrentInsight(page, "B");
	await authorityLeave(page);
	await authorityHover(page);
	await assertCurrentInsight(page, "B");
	const state = await authorityState(request);
	expect(state.calls).toHaveLength(2);
	expect(state.calls.map((c) => c.status)).toEqual(["accepted", "accepted"]);
	await expect(page.getByText("Insight A", { exact: true })).toHaveCount(0);
});
test("authority: A to B to A creates fresh current read and consumed original A cannot replace it", async ({
	page,
	request,
}) => {
	await authorityOpen(page, request);
	await authorityControl(request, { action: "hold_next", source: "A" });
	await authorityHover(page);
	await expect
		.poll(async () => (await authorityState(request)).held.length)
		.toBe(1);
	const id = (await authorityState(request)).held[0];
	if (id === undefined) throw Error("Actual original A request not held");
	await page
		.getByRole("textbox", { name: "Filter models", exact: true })
		.hover();
	await authorityRotate(page, "jwt");
	await authorityHover(page);
	await assertCurrentInsight(page, "B");
	await authorityLeave(page);
	await authorityRotate(page, "A");
	await authorityHover(page);
	await expect.soft
		.poll(async () =>
			(await authorityState(request)).calls.map((c) => c.source)
		)
		.toEqual(["A", "B", "A"]);
	await authorityControl(request, { action: "release", id });
	await authorityConsumed(page, 3);
	await assertCurrentInsight(page, "returned A");
	await expect(page.getByText("Insight A", { exact: true })).toHaveCount(0);
	expect((await authorityState(request)).calls.map((c) => c.status)).toEqual([
		"accepted",
		"accepted",
		"accepted",
	]);
});

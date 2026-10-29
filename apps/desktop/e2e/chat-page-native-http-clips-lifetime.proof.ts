import {
	assertNativeWindowLifetime,
	persistNativeLifetimeDiagnostics,
} from "./chat-page-native-http-lifetime.ts";
import { expect, test, type Page } from "@playwright/test";
import {
	chatPageControl,
	chatPageState,
} from "./chat-page-native-http-support.ts";

interface Diagnostics {
	listeners: Array<{ id: number; event: string; handler: number }>;
	callbackIds: number[];
	heldClipsListenerIds: number[];
	unexpected: unknown[];
}
async function diagnostics(page: Page): Promise<Diagnostics> {
	return page.evaluate(() =>
		Reflect.get(window, "__chatPageNativeFixture").nativeDiagnostics(),
	);
}
async function selectNode(page: Page, url: string) {
	await page.evaluate(async (url) => {
		const store = Reflect.get(
			window,
			"__chatPageNativeFixture",
		).nodeStore.getState();
		const node = store.nodes.find((node: { url: string }) => node.url === url);
		if (!node)
			throw new Error(`Actual native node profile did not load ${url}`);
		await store.setDefault(node.name);
	}, url);
}

test("late native Clips subscription acknowledgment is disposed by its old Layout effect after a real node handoff", async ({
	page,
	request,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await chatPageControl(request, { action: "reset", scenario: "share" });
	let beforeCleanup: Diagnostics | null = null;
	try {
		await page.goto("/chat-page-native-http.html?scenario=share");
		await expect(
			page.getByText("The organization copy is ready for review.", {
				exact: true,
			}),
		).toBeVisible();
		await expect
			.poll(
				async () =>
					(await diagnostics(page)).listeners.filter(
						(l) => l.event === "clips:quick-attach",
					).length,
			)
			.toBeGreaterThan(0);
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture").holdNextClipsListener(),
		);
		await selectNode(page, "http://127.0.0.1:5594");
		await expect
			.poll(async () => (await diagnostics(page)).heldClipsListenerIds.length)
			.toBe(1);
		const held = await diagnostics(page);
		const id = held.heldClipsListenerIds[0];
		if (id === undefined)
			throw new Error("The actual native Clips acknowledgment was not held");
		const listener = held.listeners.find((l) => l.id === id);
		if (!listener)
			throw new Error(
				"Held acknowledgment did not register its actual native listener",
			);
		expect(listener.event).toBe("clips:quick-attach");
		expect(held.callbackIds).toContain(listener.handler);
		// The shipping active-node hook reruns Layout's effect; this is not a callback replacement.
		await selectNode(page, "http://127.0.0.1:5591");
		await expect
			.poll(async () =>
				(await diagnostics(page)).listeners.some(
					(l) => l.event === "clips:quick-attach" && l.id > id,
				),
			)
			.toBe(true);
		expect((await diagnostics(page)).heldClipsListenerIds).toEqual([id]);
		await page.evaluate(
			(id) =>
				Reflect.get(window, "__chatPageNativeFixture").releaseClipsListener(id),
			id,
		);
		await expect
			.poll(async () =>
				(await diagnostics(page)).listeners.some((l) => l.id === id),
			)
			.toBe(false);
		await expect
			.poll(async () =>
				(await diagnostics(page)).callbackIds.includes(listener.handler),
			)
			.toBe(false);
		expect((await diagnostics(page)).heldClipsListenerIds).toEqual([]);
		expect((await diagnostics(page)).unexpected).toEqual([]);
		expect((await chatPageState(request)).unexpected).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		beforeCleanup = await diagnostics(page);
		// Release owned deferred IPC even on failure; release only resolves the real SDK promise.
		for (const id of beforeCleanup.heldClipsListenerIds)
			await page.evaluate(
				(id) =>
					Reflect.get(window, "__chatPageNativeFixture").releaseClipsListener(
						id,
					),
				id,
			);
		await page.evaluate(() =>
			Reflect.get(window, "__chatPageNativeFixture").unmount(),
		);
		await persistNativeLifetimeDiagnostics(testInfo, {
			beforeCleanup,
			afterCleanup: await diagnostics(page),
		});
	}
	// This assertion owns the scoped Clips effect, not fullscreen's window-lifetime watcher.
	await expect
		.poll(async () =>
			(await diagnostics(page)).listeners.filter(
				(l) => l.event === "clips:quick-attach",
			),
		)
		.toEqual([]);
	expect((await diagnostics(page)).unexpected).toEqual([]);
	expect(errors).toEqual([]);
	await assertNativeWindowLifetime(page);
});

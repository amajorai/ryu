import { writeFile } from "node:fs/promises";
import {
	type APIRequestContext,
	type Request as BrowserRequest,
	expect,
	type Page,
	test,
} from "@playwright/test";
import {
	NOTIFICATION_CORE_ORIGIN,
	type NotificationProofState,
} from "./system-notifications-story.host.ts";

const STORY_URL = "/system-notifications-story.html";
interface NativeNotice {
	body: string | null;
	title: string;
}
/** What the desktop host received: os-notify.ts delivers through the
 *  `show_os_notification` command (the webview Notification API is inert in
 *  WKWebView and WebView2) and listens for `os-notification-clicked`. */
interface NativeNotifications {
	clickListeners: number;
	failed: NativeNotice[];
	shown: NativeNotice[];
}
interface ProofWindow extends Window {
	__notificationNative: NativeNotifications;
	__notificationNodeStore: {
		getState: () => {
			nodes: Array<{
				name: string;
				url: string;
				token: string | null;
				userJwt?: string | null;
			}>;
		};
		setState: (update: {
			nodes: Array<{
				name: string;
				url: string;
				token: string | null;
				userJwt?: string | null;
			}>;
		}) => void;
	};
	__notificationUnexpectedNative: string[];
}
async function control(
	request: APIRequestContext,
	body: Record<string, unknown>,
	status = 200
) {
	const result = await request.post(
		`${NOTIFICATION_CORE_ORIGIN}/__proof/control`,
		{
			headers: { "x-notification-proof-control": "owned-local-fixture" },
			data: body,
		}
	);
	expect(result.status()).toBe(status);
	return result.json();
}
async function state(
	request: APIRequestContext
): Promise<NotificationProofState> {
	const result = await request.get(`${NOTIFICATION_CORE_ORIGIN}/__proof/state`);
	expect(result.status()).toBe(200);
	return result.json();
}
/** The desktop host's notification commands. `delivery: "fails"` makes the
 *  native banner refuse, as a host whose notification service is unavailable. */
async function installBoundaries(page: Page, delivery: "shown" | "fails") {
	await page.addInitScript((deliveryValue) => {
		const fixture = {
			clickListeners: 0,
			failed: [] as NativeNotice[],
			shown: [] as NativeNotice[],
		};
		const unexpected: string[] = [];
		Object.defineProperty(window, "__notificationNative", { value: fixture });
		Object.defineProperty(window, "__notificationUnexpectedNative", {
			value: unexpected,
		});
		const refuse = (command: string) => {
			unexpected.push(command);
			throw new Error(`Unexpected native command: ${command}`);
		};
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {
				metadata: {
					currentWindow: { label: "main" },
					currentWebview: { label: "main" },
				},
				invoke: async (command: string, args?: Record<string, unknown>) => {
					if (command === "plugin:event|listen") {
						// os-notify.ts routes banner clicks through this one event.
						if (
							args?.event !== "os-notification-clicked" ||
							typeof args.handler !== "number"
						) {
							return refuse(`${command}:${String(args?.event)}`);
						}
						fixture.clickListeners++;
						return fixture.clickListeners;
					}
					if (command !== "show_os_notification") {
						return refuse(command);
					}
					// Exactly the DTO os-notify.ts sends: no sender, so no image, and a
					// generated tag for click routing.
					const input = args?.input;
					if (
						!input ||
						typeof input !== "object" ||
						Object.keys(args).join() !== "input" ||
						Object.keys(input).sort().join() !==
							"body,imagePngBase64,tag,title" ||
						Reflect.get(input, "imagePngBase64") !== null ||
						typeof Reflect.get(input, "tag") !== "string" ||
						typeof Reflect.get(input, "title") !== "string" ||
						!(
							Reflect.get(input, "body") === null ||
							typeof Reflect.get(input, "body") === "string"
						)
					) {
						return refuse(`${command}:${JSON.stringify(args)}`);
					}
					const body = Reflect.get(input, "body");
					const notice: NativeNotice = {
						title: String(Reflect.get(input, "title")),
						body: typeof body === "string" ? body : null,
					};
					if (deliveryValue === "fails") {
						fixture.failed.push(notice);
						throw new Error("Notification service unavailable");
					}
					fixture.shown.push(notice);
					return null;
				},
				transformCallback: () => refuse("transformCallback"),
			},
			configurable: true,
		});
	}, delivery);
}
async function open(
	page: Page,
	request: APIRequestContext,
	{
		delivery = "shown",
		refused = 0,
	}: { delivery?: "shown" | "fails"; refused?: number } = {}
) {
	await control(request, { action: "reset", refused });
	await installBoundaries(page, delivery);
	await page.goto(STORY_URL);
	await expect(
		page.getByRole("heading", { name: "System notifications", exact: true })
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await state(request)).requests.filter(
					(r) => r.status === 200 && !r.closed
				).length
		)
		.toBe(1);
	const current = (await state(request)).requests
		.filter((r) => r.status === 200 && !r.closed)
		.at(-1);
	if (!current) {
		throw new Error("No authenticated actual notification stream");
	}
	return current;
}
async function native(page: Page) {
	return page.evaluate(() => (window as ProofWindow).__notificationNative);
}
let pageErrors: string[];
let transportEvents: Record<string, unknown>[];
let browserRequests: WeakMap<BrowserRequest, number>;
let browserRequestSequence: number;
test.beforeEach(({ page }) => {
	pageErrors = [];
	transportEvents = [];
	browserRequests = new WeakMap();
	browserRequestSequence = 0;
	page.on("request", (r) => {
		if (r.url() !== `${NOTIFICATION_CORE_ORIGIN}/api/events/all`) {
			return;
		}
		const id = ++browserRequestSequence;
		browserRequests.set(r, id);
		transportEvents.push({
			phase: "request",
			id,
			atMs: Date.now(),
			method: r.method(),
			url: r.url(),
			headers: r.headers(),
		});
	});
	page.on("response", (r) => {
		const id = browserRequests.get(r.request());
		if (id) {
			transportEvents.push({
				phase: "response",
				id,
				atMs: Date.now(),
				status: r.status(),
				headers: r.headers(),
			});
		}
	});
	page.on("requestfailed", (r) => {
		const id = browserRequests.get(r);
		if (id) {
			transportEvents.push({
				phase: "requestfailed",
				id,
				atMs: Date.now(),
				failure: r.failure(),
			});
		}
	});
	page.on("requestfinished", (r) => {
		const id = browserRequests.get(r);
		if (id) {
			transportEvents.push({ phase: "requestfinished", id, atMs: Date.now() });
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));
});
test.afterEach(async ({ page, request }, testInfo) => {
	const transportFile = testInfo.outputPath(
		"notification-browser-native-transport.json"
	);
	await writeFile(
		transportFile,
		JSON.stringify(
			{
				browserRequestSequence,
				transportEvents,
				nativeState: await state(request),
			},
			null,
			2
		)
	);
	await testInfo.attach("notification-browser-native-transport", {
		path: transportFile,
		contentType: "application/json",
	});
	expect(pageErrors).toEqual([]);
	expect(
		await page.evaluate(
			() => (window as ProofWindow).__notificationUnexpectedNative
		)
	).toEqual([]);
	expect((await state(request)).unexpected).toEqual([]);
});
test("delivers authenticated Core completion notifications to actual toasts and the desktop host's OS banner", async ({
	page,
	request,
}) => {
	const stream = await open(page, request);
	await control(request, {
		action: "emit",
		requestId: stream.id,
		notification: {
			title: "App installed",
			body: "Clips is installed and ready to enable.",
			level: "success",
		},
	});
	await expect(page.getByText("App installed", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Clips is installed and ready to enable.", { exact: true })
	).toBeVisible();
	await expect(
		page
			.locator("[data-sileo-toast]")
			.filter({ has: page.getByText("App installed", { exact: true }) })
	).toHaveAttribute("data-state", "success");
	await control(request, {
		action: "emit",
		requestId: stream.id,
		notification: {
			title: "Other agents finished with issues",
			body: "Two of three delegated tasks completed.",
			level: "warning",
		},
	});
	await expect(
		page.getByText("Other agents finished with issues", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Two of three delegated tasks completed.", { exact: true })
	).toBeVisible();
	await expect(
		page.locator("[data-sileo-toast]").filter({
			has: page.getByText("Other agents finished with issues", {
				exact: true,
			}),
		})
	).toHaveAttribute("data-state", "error");
	await expect
		.poll(() => native(page))
		.toEqual({
			clickListeners: 1,
			failed: [],
			shown: [
				{
					title: "App installed",
					body: "Clips is installed and ready to enable.",
				},
				{
					title: "Other agents finished with issues",
					body: "Two of three delegated tasks completed.",
				},
			],
		});
	const proof = await state(request);
	expect(proof.requests).toHaveLength(1);
	expect(proof.requests[0]).toMatchObject({
		method: "GET",
		path: "/api/events/all",
		token: "Bearer notification-node-a",
		userJwt: "notification-user-a",
		status: 200,
		sent: [
			{
				title: "App installed",
				body: "Clips is installed and ready to enable.",
				level: "success",
			},
			{
				title: "Other agents finished with issues",
				body: "Two of three delegated tasks completed.",
				level: "warning",
			},
		],
	});
});
test("keeps real in-app completion delivery when the native OS notification fails", async ({
	page,
	request,
}) => {
	const stream = await open(page, request, { delivery: "fails" });
	await control(request, {
		action: "emit",
		requestId: stream.id,
		notification: {
			title: "Import complete",
			body: "Four threads imported; one was already present.",
			level: "success",
		},
	});
	await expect(
		page.getByText("Import complete", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Four threads imported; one was already present.", {
			exact: true,
		})
	).toBeVisible();
	// The banner was attempted once and refused; the failure stays inside
	// os-notify.ts (no page error, no retry) and the toast above still landed.
	await expect
		.poll(() => native(page))
		.toEqual({
			clickListeners: 1,
			failed: [
				{
					title: "Import complete",
					body: "Four threads imported; one was already present.",
				},
			],
			shown: [],
		});
	expect((await state(request)).requests[0]?.sent).toEqual([
		{
			title: "Import complete",
			body: "Four threads imported; one was already present.",
			level: "success",
		},
	]);
});
test("reconnects after actual HTTP refusal and delivers a later event without a success placeholder", async ({
	page,
	request,
}) => {
	const stream = await open(page, request, { refused: 1 });
	const proof = await state(request);
	expect(proof.requests.map((r) => r.status)).toEqual([503, 200]);
	await expect(page.getByText("Thread imported", { exact: true })).toHaveCount(
		0
	);
	expect((await native(page)).shown).toEqual([]);
	await control(request, {
		action: "emit",
		requestId: stream.id,
		notification: {
			title: "Thread imported",
			body: "Research thread is ready from codex.",
			level: "success",
		},
	});
	await expect(
		page.getByText("Thread imported", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Research thread is ready from codex.", { exact: true })
	).toBeVisible();
	await expect
		.poll(async () => (await native(page)).shown)
		.toEqual([
			{
				title: "Thread imported",
				body: "Research thread is ready from codex.",
			},
		]);
});
for (const field of ["token", "userJwt"] as const) {
	test(`same-URL ${field} rotation cancels the old real stream and delivers only the new authority`, async ({
		page,
		request,
	}) => {
		let original: BrowserRequest | undefined;
		page.on("request", (r) => {
			if (
				r.url() === `${NOTIFICATION_CORE_ORIGIN}/api/events/all` &&
				!original
			) {
				original = r;
			}
		});
		const old = await open(page, request);
		if (!original) {
			throw new Error("Original actual fetch request was not observed");
		}
		const originalRequest = original;
		const aborted = page.waitForEvent("requestfailed", {
			predicate: (r) => r === originalRequest,
		});
		await page.evaluate((field) => {
			const store = (window as ProofWindow).__notificationNodeStore;
			const nodes = store.getState().nodes;
			store.setState({
				nodes: nodes.map((n) => ({
					...n,
					[field]:
						field === "token" ? "notification-node-b" : "notification-user-b",
				})),
			});
		}, field);
		const failed = await aborted;
		expect(failed.failure()?.errorText).toBe("net::ERR_ABORTED");
		await expect
			.poll(async () => {
				const proof = await state(request);
				return {
					oldClosed: proof.requests.find((r) => r.id === old.id)?.closed,
					newStreams: proof.requests.filter(
						(r) => r.id !== old.id && r.status === 200 && !r.closed
					).length,
				};
			})
			.toEqual({ oldClosed: true, newStreams: 1 });
		const proof = await state(request);
		const fresh = proof.requests.find(
			(r) => r.id !== old.id && r.status === 200 && !r.closed
		);
		if (!fresh) {
			throw new Error("New authority has no real notification connection");
		}
		expect(fresh).toMatchObject({
			token:
				field === "token"
					? "Bearer notification-node-b"
					: "Bearer notification-node-a",
			userJwt:
				field === "userJwt" ? "notification-user-b" : "notification-user-a",
		});
		// The genuine canceled connection refuses later writes; no DOM event or hook
		// callback fabricates late delivery after transport cancellation.
		await control(
			request,
			{
				action: "emit",
				requestId: old.id,
				notification: {
					title: `Old ${field} private completion`,
					body: "Must not appear.",
					level: "success",
				},
			},
			409
		);
		await control(request, {
			action: "emit",
			requestId: fresh.id,
			notification: {
				title: `Current ${field} completion`,
				body: "Only the current authority.",
				level: "success",
			},
		});
		await expect(
			page.getByText(`Current ${field} completion`, { exact: true })
		).toBeVisible();
		await expect(
			page.getByText("Only the current authority.", { exact: true })
		).toBeVisible();
		await expect(
			page.getByText(`Old ${field} private completion`, { exact: true })
		).toHaveCount(0);
		await expect
			.poll(async () => (await native(page)).shown)
			.toEqual([
				{
					title: `Current ${field} completion`,
					body: "Only the current authority.",
				},
			]);
		expect(proof.requests).toHaveLength(2);
	});
}

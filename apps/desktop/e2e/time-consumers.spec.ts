import { createServer } from "node:net";
import {
	test as base,
	chromium,
	expect,
	type Locator,
	type Page,
	type Request,
	type TestInfo,
} from "@playwright/test";
import {
	type ConsumerResources,
	consumerResources,
	installConsumerAudit,
} from "./time-consumers-resource-audit.ts";

interface BrowserReceipt {
	errors: string[];
	pending: Set<Request>;
	resources: Array<{ phase: string; value: ConsumerResources }>;
}
const receipts = new WeakMap<Page, BrowserReceipt>();
const emptyResources: ConsumerResources = {
	timers: 0,
	focus: 0,
	visibility: 0,
	storage: 0,
	timezoneObservers: 0,
	errors: [],
};

function declaredOrigin(): string {
	const baseURL = test.info().project.use.baseURL;
	if (!baseURL) {
		throw new Error("Missing actual static consumer origin");
	}
	return new URL(baseURL).origin;
}
function trackConsumer(page: Page): void {
	const origin = declaredOrigin();
	const receipt: BrowserReceipt = {
		errors: [],
		pending: new Set(),
		resources: [],
	};
	receipts.set(page, receipt);
	page.on("pageerror", (error) => receipt.errors.push(error.message));
	page.on("request", (request) => {
		receipt.pending.add(request);
		if (
			new URL(request.url()).origin !== origin ||
			request.method() !== "GET" ||
			["fetch", "xhr", "websocket"].includes(request.resourceType())
		) {
			receipt.errors.push(
				`Undeclared native request: ${request.method()} ${request.url()} (${request.resourceType()})`
			);
		}
	});
	page.on("requestfinished", (request) => receipt.pending.delete(request));
	page.on("requestfailed", (request) => {
		receipt.pending.delete(request);
		receipt.errors.push(
			`Actual request failure: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`
		);
	});
	page.on("response", (response) => {
		if (response.status() >= 400) {
			receipt.errors.push(
				`Actual HTTP refusal: ${response.status()} ${response.url()}`
			);
		}
	});
}
// Retire the mounted consumer through its real teardown control and require
// every owned day/zone resource to be released before the page goes away.
async function retireConsumer(page: Page, testInfo: TestInfo): Promise<void> {
	const receipt = receipts.get(page);
	if (!receipt) {
		throw new Error("Missing retained actual browser receipt");
	}
	let cleanupError: unknown;
	try {
		if ((await page.getByTestId("unmount-consumer").count()) !== 1) {
			throw new Error("Actual mounted-consumer teardown control is missing");
		}
		await page.getByTestId("unmount-consumer").click();
		await expect(page.getByTestId("consumer-mounted")).toHaveText("false");
		await expect(
			page.locator(
				'[data-slot="message-scroller-item"], [data-grid-cell-editor], [data-slot="grid-cell-wrapper"]'
			)
		).toHaveCount(0);
		await resourceAcknowledgment(
			page,
			"after-actual-last-consumer-unmount",
			emptyResources
		);
		await expect.poll(() => receipt.pending.size).toBe(0);
	} catch (error) {
		cleanupError = error;
	}
	await testInfo.attach("mounted-time-consumer-lifecycle", {
		body: JSON.stringify({
			errors: receipt.errors,
			resources: receipt.resources,
			pendingRequests: [...receipt.pending].map((request) => ({
				url: request.url(),
				method: request.method(),
			})),
			cleanupError:
				cleanupError instanceof Error
					? cleanupError.message
					: cleanupError === undefined
						? null
						: String(cleanupError),
		}),
		contentType: "application/json",
	});
	expect(receipt.errors).toEqual([]);
	if (cleanupError !== undefined) {
		throw cleanupError;
	}
}
// A loopback bind failure is an uncaught worker error, so the case fails.
function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => {
				if (address && typeof address === "object") {
					resolve(address.port);
				} else {
					reject(new Error("No loopback port was assigned"));
				}
			});
		});
	});
}
// `consumer` is Playwright's own page. `genuine` attaches with `noDefaults` to
// the default context of full Chromium, because Playwright's CDP focus
// emulation pins focus and visibility for the pages it creates; there, tab
// switches drive the browser's real focus and page-visibility lifecycle.
const test = base.extend<{ consumer: Page; genuine: Page }>({
	consumer: async ({ page }, use, testInfo) => {
		trackConsumer(page);
		await use(page);
		await retireConsumer(page, testInfo);
	},
	genuine: async ({ headless, launchOptions }, use, testInfo) => {
		const port = await freeLoopbackPort();
		const launched = await chromium.launch({
			...launchOptions,
			...(launchOptions.executablePath ? {} : { channel: "chromium" }),
			headless,
			args: [
				...(launchOptions.args ?? []),
				`--remote-debugging-port=${port}`,
				"--window-size=1280,720",
			],
		});
		try {
			const browser = await chromium.connectOverCDP(
				`http://127.0.0.1:${port}`,
				{ noDefaults: true }
			);
			const [context] = browser.contexts();
			if (!context) {
				throw new Error("Chromium exposed no default browser context");
			}
			const page = await context.newPage();
			trackConsumer(page);
			await use(page);
			await page.bringToFront();
			await retireConsumer(page, testInfo);
			await browser.close();
		} finally {
			await launched.close();
		}
	},
});

async function resourceAcknowledgment(
	page: Page,
	phase: string,
	expected: ConsumerResources
): Promise<void> {
	const receipt = receipts.get(page);
	if (!receipt) {
		throw new Error("Missing actual browser lifecycle receipt");
	}
	try {
		await expect.poll(() => consumerResources(page)).toEqual(expected);
	} finally {
		// Retain the actual nonzero/mismatched snapshot when a boundary fails.
		receipt.resources.push({ phase, value: await consumerResources(page) });
	}
}
async function raw(page: Page, testId: string): Promise<string> {
	const value = await page.getByTestId(testId).textContent();
	if (value === null) {
		throw new Error(`Missing mounted consumer readback: ${testId}`);
	}
	return value;
}
async function transcriptRows(page: Page): Promise<void> {
	const row = page.locator(
		'[data-slot="message-scroller-item"][data-message-id="retained-user"]'
	);
	await expect(row).toHaveCount(1);
	await expect(
		row.getByText("Retained midnight question", { exact: true })
	).toBeVisible();
	await expect(
		row.getByText("Retained midnight answer", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Retained midnight question", { exact: true })
	).toHaveCount(1);
	await expect(
		page.getByText("Retained midnight answer", { exact: true })
	).toHaveCount(1);
}

test("unchanged shipping transcript observes acknowledged New York civil midnight", async ({
	consumer: page,
}) => {
	// Controlled browser clock, real Date/timer/hook/component implementation.
	// This is not physical wall-clock midnight or OS suspend/visibility acceptance.
	const before = new Date("2026-03-09T03:59:58.000Z");
	await page.clock.install({ time: before });
	await page.clock.pauseAt(before);
	await installConsumerAudit(page);
	await page.goto("/time-consumers-proof.html?view=transcript");
	await page.clock.runFor(32);
	await expect(page.getByTestId("day-acknowledgment")).toHaveText(
		`America/New_York:${Date.parse("2026-03-08T05:00:00Z")}`
	);
	await transcriptRows(page);
	const separator = page.locator('[data-slot="chat-date-separator"]');
	await expect(separator).toHaveCount(1);
	await expect(separator).toHaveText("Today");
	const original = await raw(page, "original-message-bytes");
	expect(JSON.parse(original)).toEqual([
		{
			id: "retained-user",
			role: "user",
			createdAt: "2026-03-08T05:30:00.000Z",
			parts: [{ type: "text", text: "Retained midnight question" }],
		},
		{
			id: "retained-assistant",
			role: "assistant",
			createdAt: "2026-03-08T05:31:00.000Z",
			parts: [{ type: "text", text: "Retained midnight answer" }],
		},
	]);
	await expect(page.getByTestId("current-message-bytes")).toHaveText(original);
	await resourceAcknowledgment(page, "before-midnight", {
		timers: 1,
		focus: 1,
		visibility: 1,
		storage: 2,
		timezoneObservers: 2,
		errors: [],
	});
	await page.clock.runFor(2100);
	// Separate mounted observer acknowledges the actual clock wake. It neither
	// supplies a day prop to MessageList nor changes its retained message identity.
	await expect(page.getByTestId("day-acknowledgment")).toHaveText(
		`America/New_York:${Date.parse("2026-03-09T04:00:00Z")}`
	);
	await expect(separator).toHaveText("Yesterday");
	await transcriptRows(page);
	await expect(page.getByTestId("current-message-bytes")).toHaveText(original);
	await resourceAcknowledgment(page, "after-acknowledged-midnight", {
		timers: 1,
		focus: 1,
		visibility: 1,
		storage: 2,
		timezoneObservers: 2,
		errors: [],
	});
});

const transcriptResources: ConsumerResources = {
	timers: 1,
	focus: 1,
	visibility: 1,
	storage: 2,
	timezoneObservers: 2,
	errors: [],
};
// Mount the shipping transcript under a paused clock shortly before a New York
// civil midnight; the paused clock fires no timer unless a case runs it.
async function mountTranscriptBefore(
	page: Page,
	at: string
): Promise<{ original: string; separator: Locator }> {
	const before = new Date(at);
	await page.clock.install({ time: before });
	await page.clock.pauseAt(before);
	await installConsumerAudit(page);
	await page.goto(
		new URL(
			"/time-consumers-proof.html?view=transcript",
			test.info().project.use.baseURL
		).href
	);
	await page.clock.runFor(32);
	await transcriptRows(page);
	const separator = page.locator('[data-slot="chat-date-separator"]');
	await expect(separator).toHaveCount(1);
	await expect(separator).toHaveText("Today");
	const original = await raw(page, "original-message-bytes");
	await expect(page.getByTestId("current-message-bytes")).toHaveText(original);
	return { original, separator };
}
// Observation only: top-level window focus/blur and document visibility, as
// the browser delivers them. Nothing is dispatched.
async function recordTopLifecycle(page: Page): Promise<void> {
	await page.evaluate(() => {
		const log: string[] = [];
		Reflect.set(window, "__topLifecycle", log);
		for (const type of ["focus", "blur"]) {
			window.addEventListener(
				type,
				(event) => {
					if (event.target === window) {
						log.push(type);
					}
				},
				true
			);
		}
		document.addEventListener(
			"visibilitychange",
			() => log.push(document.visibilityState),
			true
		);
	});
}
function takeTopLifecycle(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const log = Reflect.get(window, "__topLifecycle");
		if (!Array.isArray(log)) {
			throw new Error("Missing top-level lifecycle recorder");
		}
		return log.splice(0).map(String);
	});
}
// Give keyboard focus to an embedded frame, so the top-level window genuinely
// blurs while the page stays visible.
async function focusEmbeddedFrame(page: Page): Promise<Locator> {
	await page.evaluate(() => {
		const frame = document.createElement("iframe");
		frame.title = "Embedded focus owner";
		frame.srcdoc = "<button type=button>Embedded control</button>";
		document.body.append(frame);
	});
	const control = page
		.frameLocator('iframe[title="Embedded focus owner"]')
		.getByRole("button", { name: "Embedded control" });
	await control.focus();
	await expect(control).toBeFocused();
	return control;
}
const pageState = (page: Page) =>
	page.evaluate(() => ({
		focused: document.hasFocus(),
		visibility: document.visibilityState,
		embeddedOwnsFocus: document.activeElement?.tagName === "IFRAME",
	}));

test("a focus-only return re-labels the mounted transcript after a missed spring midnight", async ({
	genuine: page,
}) => {
	await page.bringToFront();
	const { original, separator } = await mountTranscriptBefore(
		page,
		"2026-03-09T03:30:00.000Z"
	);
	await recordTopLifecycle(page);
	await focusEmbeddedFrame(page);
	expect(await takeTopLifecycle(page)).toEqual(["blur"]);
	// Past the 23-hour day's midnight with no timer delivery: still stale.
	await page.clock.setSystemTime(new Date("2026-03-09T04:30:00.000Z"));
	await expect(separator).toHaveText("Today");
	// Keyboard focus leaves the frame for the top document. The page was
	// visible throughout, so only the window focus listener can observe this.
	await page.keyboard.press("Shift+Tab");
	await expect
		.poll(() => pageState(page))
		.toEqual({
			focused: true,
			visibility: "visible",
			embeddedOwnsFocus: false,
		});
	expect(await takeTopLifecycle(page)).toEqual(["focus"]);
	await expect(separator).toHaveText("Yesterday");
	await transcriptRows(page);
	await expect(page.getByTestId("current-message-bytes")).toHaveText(original);
	await resourceAcknowledgment(
		page,
		"after-focus-only-return",
		transcriptResources
	);
});

test("a visibility-only return re-labels the mounted transcript after a missed spring midnight", async ({
	genuine: page,
}) => {
	await page.bringToFront();
	const { original, separator } = await mountTranscriptBefore(
		page,
		"2026-03-09T03:30:00.000Z"
	);
	// Focus stays inside the embedded frame, so the tab switch below hides and
	// shows the page without any top-level window focus event.
	await focusEmbeddedFrame(page);
	await recordTopLifecycle(page);
	const away = await page.context().newPage();
	try {
		await away.goto("about:blank");
		await away.bringToFront();
		await expect
			.poll(() => pageState(page))
			.toEqual({
				focused: false,
				visibility: "hidden",
				embeddedOwnsFocus: true,
			});
		// Past the 23-hour day's midnight while hidden: no timer delivery.
		await page.clock.setSystemTime(new Date("2026-03-09T04:30:00.000Z"));
		await expect(separator).toHaveText("Today");
		await page.bringToFront();
		await expect
			.poll(() => pageState(page))
			.toEqual({
				focused: true,
				visibility: "visible",
				embeddedOwnsFocus: true,
			});
		expect(await takeTopLifecycle(page)).toEqual(["hidden", "visible"]);
		await expect(separator).toHaveText("Yesterday");
	} finally {
		await away.close();
	}
	await transcriptRows(page);
	await expect(page.getByTestId("current-message-bytes")).toHaveText(original);
	await resourceAcknowledgment(
		page,
		"after-visibility-only-return",
		transcriptResources
	);
});

interface NativeCalendarNames {
	cell: string;
	day: string;
	month: string;
	shortMonth: string;
	weekday: string;
}
function nativeNames(
	page: Page,
	locale: string,
	day: number
): Promise<NativeCalendarNames> {
	return page.evaluate(
		({ locale, day }) => {
			const date = new Date(2026, 2, day);
			return {
				cell: new Intl.DateTimeFormat(locale).format(date),
				day: date.toLocaleDateString(locale),
				weekday: new Intl.DateTimeFormat(locale, { weekday: "long" }).format(
					date
				),
				month: new Intl.DateTimeFormat(locale, { month: "long" }).format(date),
				shortMonth: new Intl.DateTimeFormat(locale, { month: "short" }).format(
					date
				),
			};
		},
		{ locale, day }
	);
}
const regexText = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function selectedCalendarDay(
	editor: Locator,
	names: NativeCalendarNames
): Promise<Locator> {
	const selected = editor.locator('button[data-selected-single="true"]');
	await expect(selected).toHaveCount(1);
	await expect(selected).toHaveAccessibleName(
		new RegExp(regexText(names.weekday))
	);
	await expect(selected).toHaveAccessibleName(
		new RegExp(regexText(names.month))
	);
	await expect(selected).toHaveAttribute("data-day", names.day);
	const month = editor.locator('select:has(option[value="2"])');
	await expect(month).toHaveCount(1);
	await expect(month).toHaveValue("2");
	await expect(month.locator("option:checked")).toHaveText(names.shortMonth);
	return selected;
}
async function openEditor(page: Page, cell: Locator): Promise<Locator> {
	await cell.focus();
	await expect(cell).toBeFocused();
	await page.keyboard.press("F2");
	const editor = page.locator("[data-grid-cell-editor]");
	await expect(editor).toHaveCount(1);
	await expect(editor.locator('[data-slot="calendar"]')).toBeVisible();
	await expect(
		editor.locator('button[data-selected-single="true"]')
	).toBeFocused();
	return editor;
}

test("real DateCell keyboard calendar retains selected locale and acknowledged civil value", async ({
	consumer: page,
}) => {
	await installConsumerAudit(page);
	await page.goto("/time-consumers-proof.html?view=grid");
	await expect(page.getByTestId("provider-locale")).toHaveText("en-US");
	const original = await raw(page, "calendar-original-records");
	expect(JSON.parse(original)).toEqual([
		{ id: "edited", date: "2026-03-15", unrelated: "retained" },
		{ id: "foreign", date: "2025-12-31", unrelated: "other row" },
	]);
	await expect(page.getByTestId("calendar-records")).toHaveText(original);
	await expect(page.getByTestId("calendar-updates")).toHaveText("[]");
	const cell = page.locator('[data-slot="grid-cell-wrapper"]');
	const content = cell.locator('[data-slot="grid-cell-content"]');
	const english = await nativeNames(page, "en-US", 15);
	await expect(content).toHaveText(english.cell);
	await resourceAcknowledgment(page, "mounted-date-cell", {
		...emptyResources,
		timezoneObservers: 1,
	});
	let editor = await openEditor(page, cell);
	await selectedCalendarDay(editor, english);
	const calendar = editor.locator('[data-slot="calendar"]');
	// English: DayPicker's own names and a Sunday-first week.
	await expect(calendar.locator("th[aria-label]").first()).toHaveAttribute(
		"aria-label",
		"Sunday"
	);
	await expect(calendar.locator(".rdp-button_previous")).toHaveAttribute(
		"aria-label",
		"Go to the Previous Month"
	);
	// Invoke the provider's public language action, keeping the genuine editor
	// open instead of clicking an outside fixture control that dismisses it.
	await page.evaluate(() => {
		const controller = Reflect.get(window, "__timeConsumersProof");
		if (!controller || typeof controller.selectLocale !== "function") {
			throw new Error("Missing actual provider language action");
		}
		controller.selectLocale("de-DE");
	});
	// The shipping catalog resolves the requested de-DE to its German pack locale.
	await expect(page.getByTestId("provider-locale")).toHaveText("de");
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue("--ryu-locale")
			)
		)
		.toBe("de");
	const german15 = await nativeNames(page, "de", 15);
	await expect(content).toHaveText(german15.cell);
	const selected = await selectedCalendarDay(editor, german15);
	// The live switch moves the week start to Monday, in the real engine's week
	// data, with the editor still open. Only this assertion and the first grid
	// day below depend on the product alone.
	await expect(calendar.locator("th[aria-label]").first()).toHaveAttribute(
		"aria-label",
		"Montag"
	);
	// The next four names confirm what a person reads, not that the product
	// supplies them: this harness's document localizer rewrites DayPicker's own
	// English aria-labels to German, so they also pass with the product's
	// labelNav, labelNext, labelPrevious and labelMonthDropdown removed. The
	// unit files (lib/calendar-default-localization.test.tsx and
	// lib/grid-date-cell-editor.test.tsx) prove the product's names.
	await expect(calendar.locator("nav")).toHaveAttribute(
		"aria-label",
		"Navigationsleiste"
	);
	await expect(calendar.locator(".rdp-button_previous")).toHaveAttribute(
		"aria-label",
		"Zum vorherigen Monat"
	);
	await expect(calendar.locator(".rdp-button_next")).toHaveAttribute(
		"aria-label",
		"Zum nächsten Monat"
	);
	await expect(calendar.locator("select").first()).toHaveAttribute(
		"aria-label",
		"Monat auswählen"
	);
	const firstGridDay = await page.evaluate(() =>
		new Date(2026, 1, 23).toLocaleDateString("de")
	);
	await expect(
		calendar
			.locator('[role="grid"] tbody tr')
			.first()
			.locator("button[data-day]")
			.first()
	).toHaveAttribute("data-day", firstGridDay);
	await expect(page.getByTestId("calendar-records")).toHaveText(original);
	await expect(page.getByTestId("calendar-updates")).toHaveText("[]");
	// The relabelled editor keeps keyboard focus on the selected day, so the
	// next arrow key moves from it without any pointer or programmatic focus.
	await expect(selected).toBeFocused();
	await page.keyboard.press("ArrowRight");
	const german16 = await nativeNames(page, "de", 16);
	await expect(
		editor.locator(`button[data-day="${german16.day}"]`)
	).toBeFocused();
	await expect(page.getByTestId("calendar-updates")).toHaveText("[]");
	await page.keyboard.press("Escape");
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId("calendar-records")).toHaveText(original);
	await expect(content).toHaveText(german15.cell);
	editor = await openEditor(page, cell);
	const reopened = await selectedCalendarDay(editor, german15);
	await expect(reopened).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(
		editor.locator(`button[data-day="${german16.day}"]`)
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId("calendar-updates")).toHaveText(
		JSON.stringify([{ rowIndex: 0, columnId: "date", value: "2026-03-16" }])
	);
	await expect(page.getByTestId("calendar-records")).toHaveText(
		JSON.stringify([
			{ id: "edited", date: "2026-03-16", unrelated: "retained" },
			{ id: "foreign", date: "2025-12-31", unrelated: "other row" },
		])
	);
	await expect(content).toHaveText(german16.cell);
	editor = await openEditor(page, cell);
	await selectedCalendarDay(editor, german16);
	await page.keyboard.press("Escape");
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId("calendar-updates")).toHaveText(
		JSON.stringify([{ rowIndex: 0, columnId: "date", value: "2026-03-16" }])
	);
	await resourceAcknowledgment(page, "acknowledged-keyboard-selection", {
		...emptyResources,
		timezoneObservers: 1,
	});
});

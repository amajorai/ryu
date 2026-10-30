import { createServer } from "node:net";
import { test as base, chromium, expect, type Page } from "@playwright/test";
import { temporalCallsites } from "./time-dates-source-map.ts";

// Shipping grouped rows, immutable static data. No native transport acceptance.
interface ResourceReceipt {
	focus: number;
	timers: number;
	visibility: number;
}
interface GenuineForeground {
	errors: string[];
	page: Page;
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
// Playwright turns on CDP focus emulation for every page it creates, which pins
// document.hasFocus() to true and visibilityState to "visible" across tab and
// window switches. Foreground cases therefore attach with `noDefaults` to the
// default context of full Chromium (the headless shell has no tab lifecycle),
// where tab switches and window minimization drive the browser's real focus
// and page-visibility lifecycle. The launching connection ignores that context.
const test = base.extend<{ genuine: GenuineForeground }>({
	genuine: async ({ headless, launchOptions }, use) => {
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
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await use({ errors, page });
			await browser.close();
			expect(errors).toEqual([]);
		} finally {
			await launched.close();
		}
	},
});
interface ForegroundState {
	focused: boolean;
	visibility: DocumentVisibilityState;
}
function foregroundState(page: Page): Promise<ForegroundState> {
	return page.evaluate(() => ({
		focused: document.hasFocus(),
		visibility: document.visibilityState,
	}));
}
// Record native lifecycle delivery in the page (observation only, no dispatch).
async function recordLifecycle(page: Page): Promise<void> {
	await page.evaluate(() => {
		const log: string[] = [];
		Reflect.set(window, "__lifecycleEvents", log);
		window.addEventListener("focus", () => log.push("focus"), true);
		window.addEventListener("blur", () => log.push("blur"), true);
		document.addEventListener(
			"visibilitychange",
			() => log.push(document.visibilityState),
			true
		);
	});
}
function takeLifecycle(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const log = Reflect.get(window, "__lifecycleEvents");
		if (!Array.isArray(log)) {
			throw new Error("Missing native lifecycle recorder");
		}
		return log.splice(0).map(String);
	});
}
const foregroundPage: ForegroundState = {
	focused: true,
	visibility: "visible",
};
const backgroundPage: ForegroundState = {
	focused: false,
	visibility: "hidden",
};
const pageErrors = new WeakMap<Page, string[]>();
// The mounted Sidebar graph is large; a cold dev-server page load needs headroom.
test.describe.configure({ timeout: 240_000 });
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});

// Audit owned browser resources without replacing any component/hook/clock.
async function installResourceAudit(page: Page): Promise<void> {
	const directory = process.env.RYU_TIME_DATES_DIST;
	const callsites = directory ? temporalCallsites(directory) : [];
	await page.addInitScript((callsites) => {
		const timers = new Set<number>();
		const listeners = new Map<EventListenerOrEventListenerObject, string>();
		const originalSet = window.setTimeout.bind(window);
		const originalClear = window.clearTimeout.bind(window);
		const originalAdd = EventTarget.prototype.addEventListener;
		const originalRemove = EventTarget.prototype.removeEventListener;
		const owned = () => {
			const stack = new Error("Audit temporal resource ownership").stack ?? "";
			if (callsites.length === 0) {
				return stack.includes("/lib/display-day.ts");
			}
			let unknown = false;
			for (const frame of stack.split("\n")) {
				const match = /(https?:\/\/[^\s)]+\/([^/\s)]+\.js)):(\d+):(\d+)/.exec(
					frame
				);
				if (!match) {
					continue;
				}
				const [, url, file, line, column] = match;
				if (!(url && file && line && column)) {
					throw new Error("Invalid native resource stack frame");
				}
				const address = new URL(url);
				if (
					address.origin !== location.origin ||
					!address.pathname.includes("/assets/")
				) {
					continue;
				}
				const site = callsites.find(
					(candidate) =>
						candidate.file === file &&
						candidate.line === Number(line) &&
						candidate.start <= Number(column) - 1 &&
						(candidate.end === null || Number(column) - 1 < candidate.end)
				);
				if (site?.owned === true) {
					return true;
				}
				if (!site || site.owned === null) {
					unknown = true;
				}
			}
			if (unknown) {
				throw new Error(
					"Unattributed native resource callsite in authentic static bundle"
				);
			}
			return false;
		};
		window.setTimeout = ((
			handler: TimerHandler,
			delay?: number,
			...args: unknown[]
		) => {
			if (!owned() || typeof handler !== "function") {
				return originalSet(handler, delay, ...args);
			}
			const handle = originalSet(() => {
				timers.delete(handle);
				handler(...args);
			}, delay);
			timers.add(handle);
			return handle;
		}) as typeof window.setTimeout;
		window.clearTimeout = ((handle?: number) => {
			if (handle !== undefined) {
				timers.delete(handle);
			}
			originalClear(handle);
		}) as typeof window.clearTimeout;
		EventTarget.prototype.addEventListener = function (type, handler, options) {
			if (
				handler &&
				owned() &&
				(type === "focus" || type === "visibilitychange")
			) {
				listeners.set(handler, type);
			}
			return Reflect.apply(originalAdd, this, [type, handler, options]);
		};
		EventTarget.prototype.removeEventListener = function (
			type,
			handler,
			options
		) {
			if (handler) {
				listeners.delete(handler);
			}
			return Reflect.apply(originalRemove, this, [type, handler, options]);
		};
		Object.defineProperty(window, "__displayDayResources", {
			value: () => ({
				timers: timers.size,
				focus: [...listeners.values()].filter((type) => type === "focus")
					.length,
				visibility: [...listeners.values()].filter(
					(type) => type === "visibilitychange"
				).length,
			}),
		});
	}, callsites);
}
async function resources(page: Page): Promise<ResourceReceipt> {
	return page.evaluate(() => {
		const read = Reflect.get(window, "__displayDayResources");
		if (typeof read !== "function") {
			throw new Error("Missing owned browser resource audit");
		}
		return read();
	});
}
const rowNames = ["Stable midnight row 1", "Stable midnight row 0"];
async function grouped(page: Page, key: string): Promise<void> {
	const section = page.locator(`[data-subsection-key="${key}"]`);
	await expect(section).toHaveCount(1);
	await expect(section).toBeVisible();
	// Scope to the actual grouped container; a floating label alone cannot pass.
	await expect(section.getByText(/^Stable midnight row [01]$/)).toHaveText(
		rowNames
	);
	for (const title of rowNames) {
		await expect(page.getByText(title, { exact: true })).toHaveCount(1);
	}
}
async function setup(
	page: Page,
	season: string,
	at: string,
	audit = false
): Promise<string> {
	await page.clock.install({ time: new Date(at) });
	await page.clock.pauseAt(new Date(at));
	if (audit) {
		await installResourceAudit(page);
	}
	await page.addInitScript(() =>
		localStorage.setItem("ryu:timezone", "America/New_York")
	);
	// Absolute: a genuine default browser context carries no configured baseURL.
	await page.goto(
		new URL(
			`/sidebar-picker-story.html?rollover=${season}`,
			test.info().project.use.baseURL
		).href
	);
	await grouped(page, "today");
	const receipt = await page.getByTestId("immutable-row-stamps").textContent();
	expect(receipt).not.toBeNull();
	return receipt as string;
}
for (const [season, before, stamps] of [
	[
		"spring",
		"2026-03-09T03:59:59Z",
		["2026-03-08T05:30Z", "2026-03-09T03:30Z"],
	],
	[
		"autumn",
		"2026-11-02T04:59:59Z",
		["2026-11-01T04:30Z", "2026-11-02T04:30Z"],
	],
] as const) {
	test(`mounted Sidebar moves unchanged ${season} rows at New York midnight`, async ({
		page,
	}) => {
		const receipt = await setup(page, season, before);
		expect(JSON.parse(receipt)).toEqual(
			stamps.map((stamp, index) => ({
				id: `rollover-${index}`,
				createdAt: Date.parse(stamp),
				updatedAt: Date.parse(stamp),
			}))
		);
		await page.clock.runFor(2000);
		await expect(page.locator('[data-subsection-key="today"]')).toHaveCount(0);
		await grouped(page, "yesterday");
		await expect(page.getByTestId("immutable-row-stamps")).toHaveText(receipt);
	});
}
test("mounted Sidebar follows display zone changes without replacing rows", async ({
	page,
}) => {
	const receipt = await setup(page, "spring", "2026-03-09T03:59:59Z");
	await page.getByRole("button", { name: "Use UTC", exact: true }).click();
	await expect(
		page
			.locator('[data-subsection-key="today"]')
			.getByText(rowNames[0], { exact: true })
	).toBeVisible();
	await expect(
		page
			.locator('[data-subsection-key="yesterday"]')
			.getByText(rowNames[1], { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Use New York", exact: true }).click();
	await grouped(page, "today");
	await expect(page.getByTestId("immutable-row-stamps")).toHaveText(receipt);
});
test("real foreground return observes forward and backward wall clock jumps", async ({
	genuine: { page },
}) => {
	const receipt = await setup(page, "autumn", "2026-11-02T04:59:59Z");
	await page.bringToFront();
	await expect.poll(() => foregroundState(page)).toEqual(foregroundPage);
	await recordLifecycle(page);
	const away = await page.context().newPage();
	try {
		await away.goto("about:blank");
		for (const [at, stale, bucket] of [
			["2026-11-02T05:30:00Z", "today", "yesterday"],
			["2026-11-02T04:59:59Z", "yesterday", "today"],
		] as const) {
			// A real tab switch: the Sidebar page must genuinely lose focus and be
			// hidden, or the return below is not a foreground transition.
			await away.bringToFront();
			await expect.poll(() => foregroundState(page)).toEqual(backgroundPage);
			expect(await takeLifecycle(page)).toEqual(
				expect.arrayContaining(["blur", "hidden"])
			);
			// The paused clock fires no timer: only the return can observe the jump.
			await page.clock.setSystemTime(new Date(at));
			await grouped(page, stale);
			await page.bringToFront();
			await expect.poll(() => foregroundState(page)).toEqual(foregroundPage);
			expect(await takeLifecycle(page)).toEqual(
				expect.arrayContaining(["visible", "focus"])
			);
			await grouped(page, bucket);
			await expect(page.getByTestId("immutable-row-stamps")).toHaveText(
				receipt
			);
		}
	} finally {
		await away.close();
	}
});
test("unmounted rows remount against the current civil date", async ({
	page,
}) => {
	const receipt = await setup(page, "spring", "2026-03-09T03:59:59Z");
	await page
		.getByRole("button", { name: "Toggle mounted rows", exact: true })
		.click();
	await expect(page.getByText(rowNames[0], { exact: true })).toHaveCount(0);
	await page.clock.runFor(2000);
	await page
		.getByRole("button", { name: "Toggle mounted rows", exact: true })
		.click();
	await grouped(page, "yesterday");
	await expect(page.getByTestId("immutable-row-stamps")).toHaveText(receipt);
});
test("last mounted Sidebar subscriber releases timers and event listeners", async ({
	page,
}) => {
	await setup(page, "spring", "2026-03-09T03:59:59Z", true);
	await expect
		.poll(() => resources(page))
		.toEqual({ timers: 1, focus: 1, visibility: 1 });
	for (let cycle = 0; cycle < 3; cycle++) {
		await page
			.getByRole("button", { name: "Toggle mounted rows", exact: true })
			.click();
		await expect
			.poll(() => resources(page))
			.toEqual({ timers: 0, focus: 0, visibility: 0 });
		await page.clock.runFor(2000);
		await page
			.getByRole("button", { name: "Toggle mounted rows", exact: true })
			.click();
		await grouped(page, "yesterday");
		await expect
			.poll(() => resources(page))
			.toEqual({ timers: 1, focus: 1, visibility: 1 });
	}
});
test("a genuinely hidden Sidebar resumes after a suspended midnight clock jump", async ({
	genuine: { page },
}) => {
	const receipt = await setup(page, "autumn", "2026-11-02T04:59:59Z");
	await page.bringToFront();
	await expect.poll(() => foregroundState(page)).toEqual(foregroundPage);
	await recordLifecycle(page);
	// Minimize the Sidebar's own browser window (a window lifecycle change, not a
	// tab switch) and confirm the browser really hid the page.
	const session = await page.context().newCDPSession(page);
	const { windowId } = await session.send("Browser.getWindowForTarget");
	const windowState = async () =>
		(await session.send("Browser.getWindowBounds", { windowId })).bounds
			.windowState;
	await session.send("Browser.setWindowBounds", {
		windowId,
		bounds: { windowState: "minimized" },
	});
	await expect.poll(windowState).toBe("minimized");
	await expect.poll(() => foregroundState(page)).toEqual(backgroundPage);
	expect(await takeLifecycle(page)).toEqual(
		expect.arrayContaining(["blur", "hidden"])
	);
	// Suspended past midnight: the paused clock fires no timer while hidden.
	await page.clock.setSystemTime(new Date("2026-11-02T05:30:00Z"));
	await grouped(page, "today");
	await session.send("Browser.setWindowBounds", {
		windowId,
		bounds: { windowState: "normal" },
	});
	await expect.poll(windowState).toBe("normal");
	await expect
		.poll(() => page.evaluate(() => document.visibilityState))
		.toBe("visible");
	expect(await takeLifecycle(page)).toContain("visible");
	await grouped(page, "yesterday");
	await expect(page.locator('[data-subsection-key="today"]')).toHaveCount(0);
	await expect(page.getByTestId("immutable-row-stamps")).toHaveText(receipt);
	await session.detach();
});
for (const [season, before, latest] of [
	["spring", "2026-03-09T03:59:59Z", "2026-03-09T03:30Z"],
	["autumn", "2026-11-02T04:59:59Z", "2026-11-02T04:30Z"],
] as const) {
	test(`mounted messaging row stamp changes in place to Yesterday at ${season} New York midnight`, async ({
		page,
	}) => {
		const receipt = await setup(page, season, before);
		const row = page.getByTestId("midnight-agent-row");
		// Native Intl is the oracle for the clock label; the row gets no new prop.
		const clockLabel = (timeZone: string) =>
			page.evaluate(
				({ at, zone }) =>
					new Intl.DateTimeFormat(undefined, {
						hour: "numeric",
						minute: "2-digit",
						timeZone: zone,
					}).format(new Date(at)),
				{ at: Date.parse(latest), zone: timeZone }
			);
		const newYork = await clockLabel("America/New_York");
		expect(newYork).toMatch(/^11:30\sPM$/);
		const clockStamp = row.getByText(newYork, { exact: true });
		await expect(clockStamp).toHaveCount(1);
		await clockStamp.evaluate((node) => {
			Reflect.set(node, "__midnightIdentity", "retained");
		});
		// The preview lives in the agent name's tooltip on the one-line row.
		await row.hover();
		await expect(
			page.getByTestId("agent-chat-preview-midnight-agent")
		).toContainText("Retained agent preview");
		await page.clock.runFor(2000);
		const yesterday = row.getByText("Yesterday", { exact: true });
		await expect(yesterday).toHaveCount(1);
		await expect(row.getByText(newYork, { exact: true })).toHaveCount(0);
		// Same shipping stamp node: the label repainted, the row did not remount.
		expect(
			await yesterday.evaluate((node) =>
				Reflect.get(node, "__midnightIdentity")
			)
		).toBe("retained");
		await grouped(page, "yesterday");
		// In UTC the same instant is on the current civil day again.
		await page.getByRole("button", { name: "Use UTC", exact: true }).click();
		const utc = row.getByText(await clockLabel("UTC"), { exact: true });
		await expect(utc).toHaveCount(1);
		await expect(row.getByText("Yesterday", { exact: true })).toHaveCount(0);
		expect(
			await utc.evaluate((node) => Reflect.get(node, "__midnightIdentity"))
		).toBe("retained");
		// The preview lives in the agent name's tooltip on the one-line row.
		await row.hover();
		await expect(
			page.getByTestId("agent-chat-preview-midnight-agent")
		).toContainText("Retained agent preview");
		await expect(page.getByTestId("immutable-row-stamps")).toHaveText(receipt);
	});
}
test("a visible focused Sidebar re-buckets after a wall-clock jump without focus or visibility events", async ({
	page,
}) => {
	// 23:45 New York: the next civil midnight is fifteen minutes away, so only
	// the bounded recheck (not the midnight timer) can observe a jump past it.
	const receipt = await setup(page, "spring", "2026-03-09T03:45:00Z");
	const foreground = () =>
		page.evaluate(() => ({
			events: Number(Reflect.get(window, "__foregroundEvents")),
			focused: document.hasFocus(),
			visibility: document.visibilityState,
		}));
	await page.evaluate(() => {
		Reflect.set(window, "__foregroundEvents", 0);
		const count = () =>
			Reflect.set(
				window,
				"__foregroundEvents",
				Number(Reflect.get(window, "__foregroundEvents")) + 1
			);
		window.addEventListener("focus", count, true);
		document.addEventListener("visibilitychange", count, true);
	});
	await expect
		.poll(foreground)
		.toEqual({ events: 0, focused: true, visibility: "visible" });
	await page.clock.setSystemTime(new Date("2026-03-09T09:00:00Z"));
	await page.clock.runFor(60_000);
	await expect(page.locator('[data-subsection-key="today"]')).toHaveCount(0);
	await grouped(page, "yesterday");
	await expect(page.getByTestId("immutable-row-stamps")).toHaveText(receipt);
	expect(await foreground()).toEqual({
		events: 0,
		focused: true,
		visibility: "visible",
	});
});
test.afterEach(async ({ page }, testInfo) => {
	const errors = pageErrors.get(page);
	if (!errors) {
		throw new Error("Missing browser diagnostics");
	}
	await testInfo.attach("sidebar-clock-errors", {
		body: JSON.stringify(errors),
		contentType: "application/json",
	});
	expect(errors).toEqual([]);
});

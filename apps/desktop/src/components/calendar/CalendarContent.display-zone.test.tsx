import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// The machine clock is New York and the person chose another display zone.
// Every placement below disagrees between the two, so an implementation that
// buckets or formats in the machine zone cannot pass.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
process.env.TZ = "America/New_York";
globalThis.fetch = nativeFetch;
const { createRoot } = await import("react-dom/client");
const { CalendarContent } = await import(
	"@/src/components/calendar/CalendarContent.tsx"
);
const { ChatHistoryProvider } = await import(
	"@/src/contexts/ChatHistoryContext.tsx"
);
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { resetTimezone, setTimezonePreference } = await import(
	"@ryu/ui/lib/timezone.ts"
);

// The Calendar page mounts the New automation dialog, whose agent list, and the
// entitlement and chat-history providers, read these Core routes. Anything
// else Core is asked fails the test.
const declaredRoutes = new Set([
	"GET /node/api/agents",
	"GET /node/api/conversations",
	"GET /node/api/engine/active",
	"GET /node/api/engines",
	"PUT /node/api/preferences/entitlement-active",
	"PUT /node/api/preferences/managed-inference-entitled",
]);
const undeclared: string[] = [];
const core = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request: Request): Response => {
		const route = `${request.method} ${new URL(request.url).pathname}`;
		if (!declaredRoutes.has(route)) {
			undeclared.push(route);
			return NativeResponse.json({ error: "Unsupported" }, { status: 404 });
		}
		return NativeResponse.json({});
	},
});
const initialStore = useNodeStore.getState();

// 2026-06-10T20:00Z is Wednesday 16:00 in New York and Thursday 05:00 in Tokyo.
const NOW = "2026-06-10T20:00:00.000Z";
// New York 06:00 on June 10 is Tokyo 19:00 on June 10.
const EARLY_RUN = "2026-06-10T10:00:00.000Z";
// New York 18:30 on June 10 is Tokyo 07:30 on June 11.
const LATE_RUN = "2026-06-10T22:30:00.000Z";
// New York 23:00 on June 11 is Tokyo 12:00 on June 12.
const NOON_RUN = "2026-06-12T03:00:00.000Z";

function record(startedAt: string) {
	return {
		error: null,
		finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
		outcome: "success" as const,
		runId: null,
		startedAt,
	};
}

// A paused job shows only its recorded runs, so each placement is a real run.
const jobs = [
	{
		appId: null,
		createdAt: "2026-06-01T00:00:00.000Z",
		enabled: false,
		history: [record(EARLY_RUN), record(LATE_RUN), record(NOON_RUN)],
		id: "job-digest",
		lastOutcome: "success" as const,
		lastRunAt: NOON_RUN,
		name: "Nightly digest",
		ownerApp: null,
		requireApproval: false,
		schedule: { kind: "every" as const, interval: "1d" },
		system: false,
		target: { type: "agent" as const, agentId: "agent-digest", prompt: "go" },
		updatedAt: "2026-06-01T00:00:00.000Z",
	},
];

let mounted: { container: HTMLElement; root: Root } | undefined;
beforeEach(() => {
	setSystemTime(new Date(NOW));
	undeclared.length = 0;
	useNodeStore.setState({
		defaultNode: "calendar",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		nodes: [
			{
				name: "calendar",
				url: `${core.url.origin}/node`,
				token: "calendar-token",
				userJwt: null,
			},
		],
	});
});
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	resetTimezone();
	setSystemTime();
	useNodeStore.setState(initialStore, true);
	if (undeclared.length > 0) {
		throw new Error(
			`Core was asked undeclared routes: ${undeclared.join(", ")}`
		);
	}
});
afterAll(async () => {
	core.stop(true);
	globalThis.fetch = nativeFetch;
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountCalendar(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<EntitlementProvider>
				<ChatHistoryProvider>
					<CalendarContent
						error={null}
						jobs={jobs}
						loading={false}
						onReload={async () => undefined}
						workflowNames={new Map()}
					/>
				</ChatHistoryProvider>
			</EntitlementProvider>
		);
	});
	return container;
}

async function click(element: Element | null | undefined): Promise<void> {
	if (!(element instanceof HTMLElement)) {
		throw new Error("The control to click is not on the page");
	}
	await act(async () => {
		element.click();
	});
}

function button(
	container: HTMLElement,
	name: string
): HTMLButtonElement | null {
	return (
		[...container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === name
		) ?? null
	);
}

/** The month grid's cell for a day of June 2026 (each number is unique there). */
function monthCell(container: HTMLElement, dayOfMonth: number): HTMLElement {
	const cell = [...container.querySelectorAll<HTMLElement>("div, button")].find(
		(candidate) =>
			candidate.className.includes("min-h-[104px]") &&
			candidate.querySelector("span")?.textContent === String(dayOfMonth)
	);
	if (!cell) {
		throw new Error(`The month grid has no cell for June ${dayOfMonth}`);
	}
	return cell;
}

/** A month cell's own control for opening its day, named by its full date. */
const dayButton = (cell: HTMLElement) =>
	cell.querySelector<HTMLButtonElement>("button[aria-label]");

const isToday = (cell: HTMLElement) =>
	cell.querySelector("span")?.className.includes("bg-primary") === true;

const pillTimes = (cell: HTMLElement) =>
	[...cell.querySelectorAll("span.tabular-nums")]
		.map((span) => span.textContent ?? "")
		.filter((text) => /^\d\d:\d\d$/.test(text));

/** The event pill inside a month cell, found by its leading time label. */
function pill(cell: HTMLElement, time: string): Element | undefined {
	return [...cell.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.startsWith(time)
	);
}

test("the month grid files and labels each run in the display zone, not the machine zone", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	// The 19:00 Tokyo run stays on June 10; the 07:30 run is already June 11.
	expect(pillTimes(monthCell(container, 10))).toEqual(["19:00"]);
	expect(pillTimes(monthCell(container, 11))).toEqual(["07:30"]);
	expect(pillTimes(monthCell(container, 12))).toEqual(["12:00"]);
	// It is Thursday June 11 in Tokyo, so that is the highlighted day.
	expect(isToday(monthCell(container, 11))).toBe(true);
	expect(isToday(monthCell(container, 10))).toBe(false);
});

test("opening a run's day from the grid names the display-zone day and lists only its runs", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	await click(pill(monthCell(container, 11), "07:30"));
	const panel = container.querySelector("aside");
	expect(panel?.textContent).toContain("Thursday");
	expect(panel?.textContent).toContain("June 11, 2026");
	expect(panel?.textContent).toContain("07:30");
	expect(panel?.textContent).not.toContain("19:00");
});

test("the week grid puts each run in its display-zone column at its display-zone time", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	await click(button(container, "Week"));
	const events = [...container.querySelectorAll("[data-calendar-event]")];
	const placed = events.map((event) => {
		const column = event.parentElement as HTMLElement;
		const index = [...(column.parentElement?.children ?? [])].indexOf(column);
		return {
			// The first child of the grid row is the hour gutter.
			column: index - 1,
			time: event.querySelector("span.tabular-nums")?.textContent,
			top: (event as HTMLElement).style.getPropertyValue(
				"--calendar-event-top"
			),
		};
	});
	// Sunday is column 0, so Wednesday June 10 is 3, Thursday 4 and Friday 5.
	expect(placed).toEqual([
		{ column: 3, time: "19:00", top: `${19 * 48}px` },
		{ column: 4, time: "07:30", top: `${7.5 * 48}px` },
		{ column: 5, time: "12:00", top: `${12 * 48}px` },
	]);
	// Thursday's header is the highlighted one.
	expect(
		container.querySelector("[data-calendar-heading] .bg-primary")?.textContent
	).toBe("11");
	// The now line sits in Thursday's column at Tokyo's 05:00.
	const now = container.querySelector("[data-calendar-now]");
	const nowColumn = now?.parentElement as HTMLElement;
	expect(
		[...(nowColumn.parentElement?.children ?? [])].indexOf(nowColumn)
	).toBe(5);
	expect(
		(now as HTMLElement).style.getPropertyValue("--calendar-event-top")
	).toBe(`${5 * 48}px`);
});

test("the day view opens on the display-zone day and shows only that day's runs", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	await click(button(container, "Day"));
	const times = [...container.querySelectorAll("[data-calendar-event]")].map(
		(event) => event.querySelector("span.tabular-nums")?.textContent
	);
	expect(times).toEqual(["07:30"]);
	expect(container.textContent).toContain("Thursday, June 11, 2026");
});

test("the agenda starts at the display-zone today and lists its runs under their display-zone day", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	await click(button(container, "Agenda"));
	// June 10 in New York is already past in Tokyo's today, so it is not listed.
	const days = [...container.querySelectorAll("section")]
		.filter((section) => section.querySelector(".border-b.pb-1\\.5"))
		.map((section) => ({
			heading: section.querySelector(".border-b.pb-1\\.5")?.textContent,
			times: [...section.querySelectorAll("span.tabular-nums")]
				.map((span) => span.textContent ?? "")
				.filter((text) => /^\d\d:\d\d$/.test(text)),
		}));
	expect(days).toEqual([
		{ heading: "ThursdayJune 11, 2026Today", times: ["07:30"] },
		{ heading: "FridayJune 12, 2026", times: ["12:00"] },
	]);
	const left = (element: Element | null | undefined) =>
		(element as HTMLElement | null)?.style.getPropertyValue("--timeline-left");
	// The overview's 24-hour strip spans Tokyo's June 11 (from 15:00Z to 15:00Z):
	// the 07:30 run is 31.25% along it and the 05:00 now line 5/24 along it.
	const overview = container.querySelector(
		"[aria-label='All scheduled job status for June 11, 2026']"
	);
	expect(overview).toBeTruthy();
	expect(left(overview?.querySelector("[role='img']"))).toBe("31.25%");
	expect(left(overview?.querySelector(".z-10.w-px"))).toBe(
		`${((5 * 3_600_000) / 86_400_000) * 100}%`
	);
	// The job's own strip for June 11 places the same run at the same spot.
	const jobStrip = container.querySelector(
		"[aria-label='Nightly digest run status for June 11, 2026']"
	);
	expect(left(jobStrip?.querySelector("[role='img']"))).toBe("31.25%");
	// Friday's own strip runs from Tokyo's midnight, so its 12:00 run is half way.
	const friday = container.querySelector(
		"[aria-label='Run status for June 12, 2026']"
	);
	expect(friday).toBeTruthy();
	expect(left(friday?.querySelector("[role='img']"))).toBe("50%");
});

test("Today returns to the display-zone today and opens it", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	await click(container.querySelector("button[aria-label='Next']"));
	expect(container.textContent).toContain("July 2026");
	await click(button(container, "Today"));
	expect(container.textContent).toContain("June 2026");
	const panel = container.querySelector("aside");
	expect(panel?.textContent).toContain("Thursday");
	expect(panel?.textContent).toContain("June 11, 2026");
	expect(panel?.textContent).toContain("07:30");
});

test("changing the display zone while the calendar is open re-files every run and moves today", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	expect(pillTimes(monthCell(container, 11))).toEqual(["07:30"]);
	await act(async () => {
		// Los Angeles is UTC-7 in June: the first two runs fall on Wednesday June 10.
		setTimezonePreference("America/Los_Angeles");
	});
	expect(pillTimes(monthCell(container, 10))).toEqual(["03:00", "15:30"]);
	expect(pillTimes(monthCell(container, 11))).toEqual(["20:00"]);
	expect(pillTimes(monthCell(container, 12))).toEqual([]);
	expect(isToday(monthCell(container, 10))).toBe(true);
	expect(isToday(monthCell(container, 11))).toBe(false);
});

test("with the display zone left on the machine's own, the grid reads exactly as before", async () => {
	const container = await mountCalendar();
	expect(pillTimes(monthCell(container, 10))).toEqual(["06:00", "18:30"]);
	expect(pillTimes(monthCell(container, 11))).toEqual(["23:00"]);
	expect(isToday(monthCell(container, 10))).toBe(true);
});

test("a month cell keeps its day button and its run pills apart, so no button sits inside another", async () => {
	setTimezonePreference("Asia/Tokyo");
	const printed: string[] = [];
	const consoleError = console.error;
	console.error = (...parts: unknown[]) => {
		printed.push(parts.map(String).join(" "));
	};
	let container: HTMLElement;
	try {
		container = await mountCalendar();
	} finally {
		console.error = consoleError;
	}
	expect(container.querySelectorAll("button button")).toHaveLength(0);
	expect(
		printed.filter((message) => message.includes("cannot be a descendant of"))
	).toEqual([]);
	// The day comes first and its run after it, so Tab reaches the day, then the run.
	const controls = [...monthCell(container, 11).querySelectorAll("button")];
	expect(
		controls.map(
			(control) => control.getAttribute("aria-label") ?? control.textContent
		)
	).toEqual(["Thursday, June 11, 2026", "07:30Nightly digest"]);
	expect(controls.every((control) => control.type === "button")).toBe(true);
});

test("a month cell's day button opens that display-zone day, with or without runs", async () => {
	setTimezonePreference("Asia/Tokyo");
	const container = await mountCalendar();
	await click(dayButton(monthCell(container, 12)));
	let panel = container.querySelector("aside");
	expect(panel?.textContent).toContain("Friday");
	expect(panel?.textContent).toContain("June 12, 2026");
	expect(panel?.textContent).toContain("12:00");
	expect(panel?.textContent).not.toContain("07:30");
	await click(dayButton(monthCell(container, 15)));
	panel = container.querySelector("aside");
	expect(panel?.textContent).toContain("Monday");
	expect(panel?.textContent).toContain("June 15, 2026");
	expect(panel?.textContent).toContain("No runs scheduled");
});

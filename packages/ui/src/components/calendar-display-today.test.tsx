import {
	afterAll,
	afterEach,
	beforeAll,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Both calendars (the shared one and the Plate date node's copy) highlight
// "today" in the display time zone, not the computer's. The computer is New
// York for every case below and each one picks a display zone, or a clock,
// whose civil date differs from New York's, so DayPicker's own machine-date
// default cannot pass.
// Restored (never deleted) in teardown: Bun stops honouring later `TZ`
// assignments in this process once an assigned `TZ` is deleted.
const machineZone =
	process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = "America/New_York";
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
beforeAll(() => {
	process.env.TZ = "America/New_York";
});
const { Calendar: SharedCalendar } = await import("./calendar.tsx");
const { Calendar: EditorCalendar } = await import("./editor/ui/calendar.tsx");
const { resetTimezone, setTimezonePreference } = await import(
	"../lib/timezone.ts"
);

let mounted: { container: HTMLElement; root: Root } | undefined;
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
});
afterAll(async () => {
	process.env.TZ = machineZone;
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(node);
	});
	return container;
}

/** The ISO dates of every cell DayPicker marked as today in the open month. */
const todayCells = (calendar: HTMLElement) =>
	[...calendar.querySelectorAll('td[data-today="true"]')].map((cell) =>
		cell.getAttribute("data-day")
	);

const june = new Date(2026, 5, 1);
const calendars = [
	["shared", SharedCalendar],
	["editor", EditorCalendar],
] as const;

for (const [name, Calendar] of calendars) {
	// 2026-06-10T20:00Z: Wednesday 16:00 in New York, Thursday 05:00 in Tokyo.
	test(`${name} calendar marks the display zone's date as today when it is ahead of the computer's`, async () => {
		setSystemTime(new Date("2026-06-10T20:00:00.000Z"));
		setTimezonePreference("Asia/Tokyo");
		const calendar = await mount(<Calendar defaultMonth={june} />);
		expect(todayCells(calendar)).toEqual(["2026-06-11"]);
	});

	// 2026-06-11T05:00Z: Thursday 01:00 in New York, Wednesday 22:00 in Los Angeles.
	test(`${name} calendar marks the display zone's date as today when it is behind the computer's`, async () => {
		setSystemTime(new Date("2026-06-11T05:00:00.000Z"));
		setTimezonePreference("America/Los_Angeles");
		const calendar = await mount(<Calendar defaultMonth={june} />);
		expect(todayCells(calendar)).toEqual(["2026-06-10"]);
	});

	test(`${name} calendar left on the system zone marks the computer's own date`, async () => {
		setSystemTime(new Date("2026-06-10T20:00:00.000Z"));
		const calendar = await mount(<Calendar defaultMonth={june} />);
		expect(todayCells(calendar)).toEqual(["2026-06-10"]);
	});

	test(`${name} calendar moves today when the display zone changes while it is open`, async () => {
		setSystemTime(new Date("2026-06-10T20:00:00.000Z"));
		setTimezonePreference("Asia/Tokyo");
		const calendar = await mount(<Calendar defaultMonth={june} />);
		expect(todayCells(calendar)).toEqual(["2026-06-11"]);
		await act(async () => {
			setTimezonePreference("America/Los_Angeles");
		});
		expect(todayCells(calendar)).toEqual(["2026-06-10"]);
	});

	test(`${name} calendar moves today at the display zone's midnight while it is open`, async () => {
		// Tokyo's June 11 begins at 2026-06-10T15:00Z.
		setSystemTime(new Date("2026-06-10T14:59:59.000Z"));
		setTimezonePreference("Asia/Tokyo");
		const calendar = await mount(<Calendar defaultMonth={june} />);
		expect(todayCells(calendar)).toEqual(["2026-06-10"]);
		setSystemTime(new Date("2026-06-10T15:00:01.000Z"));
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(todayCells(calendar)).toEqual(["2026-06-11"]);
	});

	test(`${name} calendar leaves today to DayPicker when the caller names a time zone`, async () => {
		// 2026-06-10T20:00Z is June 11 in Tokyo, the caller's zone, while the
		// display zone (Los Angeles) is still on June 10.
		setSystemTime(new Date("2026-06-10T20:00:00.000Z"));
		setTimezonePreference("America/Los_Angeles");
		const calendar = await mount(
			<Calendar defaultMonth={june} timeZone="Asia/Tokyo" />
		);
		expect(todayCells(calendar)).toEqual(["2026-06-11"]);
	});

	test(`${name} calendar keeps a caller's own today`, async () => {
		setSystemTime(new Date("2026-06-10T20:00:00.000Z"));
		setTimezonePreference("Asia/Tokyo");
		const calendar = await mount(
			<Calendar defaultMonth={june} today={new Date(2026, 5, 20)} />
		);
		expect(todayCells(calendar)).toEqual(["2026-06-20"]);
	});
}

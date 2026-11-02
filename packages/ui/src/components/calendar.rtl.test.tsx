import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Under a right-to-left reading direction both calendars (the shared one and
// the Plate date node's copy) must point their month chevrons toward the edge
// each button sits on, exactly once (the shared one used to mirror twice), and
// ArrowLeft must move to the next day, as it does in DayPicker's own RTL mode.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Calendar: SharedCalendar } = await import("./calendar.tsx");
const { Calendar: EditorCalendar } = await import("./editor/ui/calendar.tsx");
const { calendarChevronOrientation } = await import("./calendar-chevron.tsx");
const { DirectionProvider } = await import("./direction.tsx");

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
});
afterAll(async () => {
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

const june = new Date(2026, 5, 1);

/** Which way the glyph inside a navigation button points. */
const chevron = (calendar: HTMLElement, button: "previous" | "next") =>
	calendar
		.querySelector(`.rdp-button_${button} [data-chevron]`)
		?.getAttribute("data-chevron");

/** Press a key on the day button (a selectable calendar renders one per day) for `isoDay` and return the day focused next. */
async function pressOnDay(
	calendar: HTMLElement,
	isoDay: string,
	key: string
): Promise<string | null | undefined> {
	const button = calendar.querySelector<HTMLButtonElement>(
		`td[data-day="${isoDay}"] button`
	);
	if (!button) {
		throw new Error(`No day button for ${isoDay}`);
	}
	await act(async () => {
		button.focus();
	});
	await act(async () => {
		button.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
	return calendar
		.querySelector('td[data-focused="true"]')
		?.getAttribute("data-day");
}

const calendars = [
	["shared", SharedCalendar],
	["editor", EditorCalendar],
] as const;

for (const [name, Calendar] of calendars) {
	describe(`${name} calendar`, () => {
		test("points the month chevrons along a left-to-right layout", async () => {
			const calendar = await mount(<Calendar defaultMonth={june} />);
			expect(chevron(calendar, "previous")).toBe("left");
			expect(chevron(calendar, "next")).toBe("right");
		});

		test("mirrors the month chevrons once under a right-to-left provider", async () => {
			const calendar = await mount(
				<DirectionProvider direction="rtl">
					<Calendar defaultMonth={june} />
				</DirectionProvider>
			);
			expect(
				calendar.querySelector("[data-slot=calendar]")?.getAttribute("dir")
			).toBe("rtl");
			expect(chevron(calendar, "previous")).toBe("right");
			expect(chevron(calendar, "next")).toBe("left");
			// No class flips the already oriented glyph a second time.
			expect(calendar.innerHTML).not.toContain("rotate-180");
			expect(calendar.innerHTML).not.toContain("-scale-x-100");
		});

		test("does not mirror again around-layout chevrons DayPicker already swapped", async () => {
			const calendar = await mount(
				<DirectionProvider direction="rtl">
					<Calendar defaultMonth={june} navLayout="around" />
				</DirectionProvider>
			);
			expect(chevron(calendar, "previous")).toBe("right");
			expect(chevron(calendar, "next")).toBe("left");
		});

		test("moves ArrowLeft to the next day under right-to-left", async () => {
			const calendar = await mount(
				<DirectionProvider direction="rtl">
					<Calendar defaultMonth={june} mode="single" />
				</DirectionProvider>
			);
			expect(await pressOnDay(calendar, "2026-06-10", "ArrowLeft")).toBe(
				"2026-06-11"
			);
			expect(await pressOnDay(calendar, "2026-06-11", "ArrowRight")).toBe(
				"2026-06-10"
			);
		});

		test("keeps ArrowLeft on the previous day left-to-right", async () => {
			const calendar = await mount(
				<Calendar defaultMonth={june} mode="single" />
			);
			expect(await pressOnDay(calendar, "2026-06-10", "ArrowLeft")).toBe(
				"2026-06-09"
			);
		});

		test("lets a caller's own dir win over the provider", async () => {
			const calendar = await mount(
				<DirectionProvider direction="rtl">
					<Calendar defaultMonth={june} dir="ltr" />
				</DirectionProvider>
			);
			expect(chevron(calendar, "previous")).toBe("left");
		});
	});
}

describe("calendarChevronOrientation", () => {
	test("swaps the default navigation's chevrons only under rtl", () => {
		expect(calendarChevronOrientation("left", "rtl", undefined)).toBe("right");
		expect(calendarChevronOrientation("right", "rtl", "after")).toBe("left");
		expect(calendarChevronOrientation("left", "ltr", undefined)).toBe("left");
		expect(calendarChevronOrientation("left", undefined, undefined)).toBe(
			"left"
		);
	});

	test("leaves around-layout and vertical chevrons as DayPicker asked", () => {
		expect(calendarChevronOrientation("right", "rtl", "around")).toBe("right");
		expect(calendarChevronOrientation("down", "rtl", undefined)).toBe("down");
		expect(calendarChevronOrientation(undefined, "rtl", undefined)).toBe(
			"down"
		);
	});
});

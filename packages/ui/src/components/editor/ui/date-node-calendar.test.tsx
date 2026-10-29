import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The real Plate date node: a mounted editor holding a date element, its
// trigger clicked open, and the popover's calendar read from the document.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Plate, PlateContent, usePlateEditor } = await import("platejs/react");
const { parseCanonicalDateValue } = await import("@platejs/date");
const { DateKit } = await import("../plugins/date-kit.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;
/** The date element's stored value, read from the mounted editor. */
let readDateValue: () => string | undefined = () => undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	document.documentElement.style.removeProperty("--ryu-locale");
	setSystemTime();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function EditorWithDate() {
	const editor = usePlateEditor({
		plugins: DateKit,
		value: [
			{
				type: "p",
				children: [
					{ text: "" },
					{ type: "date", date: "2026-03-02", children: [{ text: "" }] },
					{ text: "" },
				],
			},
		],
	});
	readDateValue = () => {
		const [entry] = Array.from(
			editor.api.nodes({ at: [], match: { type: "date" } })
		);
		const node = entry?.[0];
		return node && "date" in node && typeof node.date === "string"
			? node.date
			: undefined;
	};
	return (
		<Plate editor={editor}>
			<PlateContent />
		</Plate>
	);
}

async function mountDateNode(
	display: "de" | undefined
): Promise<HTMLElement | null> {
	// Today is in October and the node holds March 2, so a popover that opened
	// on the current month instead of the node's own could not pass.
	setSystemTime(new Date(2026, 9, 15, 12));
	if (display) {
		document.documentElement.style.setProperty("--ryu-locale", display);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialPackId={display === "de" ? "official/de" : "official/en"}
				persistPackId={() => undefined}
			>
				<EditorWithDate />
			</I18nProvider>
		);
	});
	return container.querySelector<HTMLElement>('[data-slot="popover-trigger"]');
}

async function click(element: HTMLElement | null): Promise<void> {
	await act(async () => {
		element?.click();
	});
}

const popoverCalendar = () =>
	document.querySelector<HTMLElement>('[data-slot="calendar"]');

/** The month the open popover shows, as its caption reads it. */
const shownMonth = () =>
	popoverCalendar()?.querySelector(".rdp-caption_label")?.textContent;

/** The day the open popover marks as the node's, by its local date. */
const markedDay = () =>
	popoverCalendar()
		?.querySelector('[aria-selected="true"] button[data-day]')
		?.getAttribute("data-day");

const dayButton = (date: Date) =>
	popoverCalendar()?.querySelector<HTMLButtonElement>(
		`button[data-day="${date.toLocaleDateString()}"]`
	) ?? null;

test("the date node's popover calendar speaks the display language: German navigation, Monday-first week", async () => {
	const trigger = await mountDateNode("de");
	expect(trigger).not.toBeNull();
	await click(trigger);
	const calendar = popoverCalendar();
	expect(calendar).not.toBeNull();
	expect(calendar?.querySelector("nav")?.getAttribute("aria-label")).toBe(
		"Navigationsleiste"
	);
	expect(
		calendar?.querySelector(".rdp-button_previous")?.getAttribute("aria-label")
	).toBe("Zum vorherigen Monat");
	expect(
		calendar?.querySelector("th[aria-label]")?.getAttribute("aria-label")
	).toBe("Montag");
});

test("with no display language the date node's calendar keeps DayPicker's English and still writes the picked day to the node", async () => {
	const trigger = await mountDateNode(undefined);
	expect(trigger).not.toBeNull();
	await click(trigger);
	const calendar = popoverCalendar();
	expect(calendar?.querySelector("nav")?.getAttribute("aria-label")).toBe(
		"Navigation bar"
	);
	expect(
		calendar?.querySelector("th[aria-label]")?.getAttribute("aria-label")
	).toBe("Sunday");
	// Picking March 10 writes that civil day back to the date element.
	const march10 = dayButton(new Date(2026, 2, 10));
	expect(march10).not.toBeNull();
	await click(march10);
	const picked = parseCanonicalDateValue(readDateValue() ?? "");
	expect(
		[picked?.getFullYear(), picked?.getMonth(), picked?.getDate()].join("-")
	).toBe("2026-2-10");
});

test("the date node's popover opens on the node's own month with its day marked, not on today's month", async () => {
	const trigger = await mountDateNode(undefined);
	await click(trigger);
	expect(shownMonth()).toBe("March 2026");
	expect(markedDay()).toBe(new Date(2026, 2, 2).toLocaleDateString());
});

test("after a day in another month is picked, the popover reopens on that month even if it was left elsewhere", async () => {
	const trigger = await mountDateNode(undefined);
	await click(trigger);
	await click(popoverCalendar()?.querySelector(".rdp-button_next") ?? null);
	expect(shownMonth()).toBe("April 2026");
	await click(dayButton(new Date(2026, 3, 7)));
	// Wander one month further, then close and reopen.
	await click(popoverCalendar()?.querySelector(".rdp-button_next") ?? null);
	expect(shownMonth()).toBe("May 2026");
	await click(trigger);
	expect(popoverCalendar()).toBeNull();
	await click(trigger);
	expect(shownMonth()).toBe("April 2026");
	expect(markedDay()).toBe(new Date(2026, 3, 7).toLocaleDateString());
});

import { afterAll, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

// This input changes the runtime's native Intl/Date timezone provider. It does
// not replace Intl or claim OS/WebView system-zone event acceptance.
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useDisplayDayRevision } = await import(
	"../../../../packages/ui/src/lib/display-day.ts"
);
const { formatDate, formatTime, setTimezonePreference, systemTimeZone } =
	await import("../../../../packages/ui/src/lib/timezone.ts");
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

test("mounted System clock follows native runtime zone changes while calendar values and an explicit selection stay conserved", async () => {
	const previousZone = process.env.TZ;
	const previousPreference = localStorage.getItem("ryu:timezone");
	const previousLocale =
		document.documentElement.style.getPropertyValue("--ryu-locale");
	const records = [
		{ id: "retained", calendar: "2026-01-15", unrelated: "untouched" },
	];
	const original = JSON.stringify(records);
	const instant = new Date("2026-01-15T00:30:00.000Z");
	const options = {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	} as const;
	const dateOptions = {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	} as const;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	function Consumer() {
		const revision = useDisplayDayRevision();
		return (
			<output>
				{JSON.stringify({
					revision,
					clock: formatTime(instant, options),
					calendar: formatDate(records[0].calendar, dateOptions),
				})}
			</output>
		);
	}
	function read() {
		return JSON.parse(container.textContent ?? "null") as {
			revision: string;
			clock: string;
			calendar: string;
		};
	}
	try {
		process.env.TZ = "UTC";
		setSystemTime(instant);
		document.documentElement.style.setProperty("--ryu-locale", "en-US");
		setTimezonePreference("system");
		await act(async () => root.render(<Consumer />));
		expect(read().clock).toBe("00:30");
		const calendar = read().calendar;
		expect(calendar).toBe("01/15/2026");
		for (const [zone, clock] of [
			["Asia/Tokyo", "09:30"],
			["America/Los_Angeles", "16:30"],
			["UTC", "00:30"],
		] as const) {
			await act(async () => {
				process.env.TZ = zone;
				expect(systemTimeZone()).toBe(zone);
				window.dispatchEvent(new Event("focus"));
			});
			expect(read().revision.startsWith(`${zone}:`)).toBe(true);
			expect(read().clock).toBe(clock);
			expect(read().calendar).toBe(calendar);
			expect(JSON.stringify(records)).toBe(original);
		}
		await act(async () => setTimezonePreference("Asia/Tokyo"));
		await act(async () => {
			process.env.TZ = "America/Los_Angeles";
			window.dispatchEvent(new Event("focus"));
		});
		expect(read().clock).toBe("09:30");
		expect(read().calendar).toBe(calendar);
		expect(JSON.stringify(records)).toBe(original);
		expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	} finally {
		await act(async () => root.unmount());
		container.remove();
		if (previousZone === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousZone;
		}
		setSystemTime();
		setTimezonePreference(previousPreference ?? "system");
		if (previousPreference === null) {
			localStorage.removeItem("ryu:timezone");
		}
		if (previousLocale) {
			document.documentElement.style.setProperty(
				"--ryu-locale",
				previousLocale
			);
		} else {
			document.documentElement.style.removeProperty("--ryu-locale");
		}
	}
});

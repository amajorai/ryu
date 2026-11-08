import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// The hour gutter follows the UI language like the day headers above it,
// never a fixed `HH:mm` that every locale shared. The DOM shim replaces
// `fetch` and `Response`; restore the native ones for suites sharing the run.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.Response = NativeResponse;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { TimeGridView } = await import(
	"@/src/components/calendar/TimeGridView.tsx"
);

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(async () => {
	const current = mounted;
	mounted = null;
	if (current) {
		await act(async () => {
			current.root.unmount();
		});
		current.container.remove();
	}
});

async function gutterLabels(locale: string): Promise<string[]> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
				persistPackId={() => undefined}
			>
				<TimeGridView
					days={[new Date(2026, 10, 9)]}
					eventsByDay={new Map()}
					onSelectEvent={() => undefined}
				/>
			</I18nProvider>
		);
	});
	return [...container.querySelectorAll("[data-calendar-hour] span")].map(
		(span) => (span.textContent ?? "").replace(/[\s ]/gu, " ")
	);
}

test("the Korean gutter uses the 12-hour clock with day periods", async () => {
	const labels = await gutterLabels("ko");
	expect(labels).toHaveLength(24);
	expect(labels[0]).toBe("");
	expect(labels[9]).toBe("오전 9:00");
	expect(labels[15]).toBe("오후 3:00");
	expect(labels).not.toContain("15:00");
});

test("the Arabic gutter uses Arabic day-period marks, not HH:mm", async () => {
	const labels = await gutterLabels("ar");
	expect(labels[9]).toMatch(/^[9٩]:[0٠]{2} ص$/u);
	expect(labels[15]).toMatch(/^[3٣]:[0٠]{2} م$/u);
	expect(labels).not.toContain("15:00");
});

test("the German gutter keeps a 24-hour clock", async () => {
	const labels = await gutterLabels("de");
	expect(labels[9]).toBe("9:00");
	expect(labels[23]).toBe("23:00");
});

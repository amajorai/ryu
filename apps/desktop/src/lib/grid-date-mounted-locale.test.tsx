import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createTable, getCoreRowModel } from "@tanstack/react-table";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
	await GlobalRegistrator.unregister();
});
const { DateCell } = await import(
	"../../../../packages/ui/src/components/data-grid/data-grid-cell-variants.tsx"
);

test("mounted shipping DateCell follows external locale projection without changing its calendar value", async () => {
	const records = [{ date: "2026-01-15", unrelated: "retained" }];
	const table = createTable({
		data: records,
		columns: [{ accessorKey: "date" }],
		getCoreRowModel: getCoreRowModel(),
		state: {},
		onStateChange: () => {},
		renderFallbackValue: null,
	});
	const cell = table.getRowModel().rows[0].getAllCells()[0];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const originalObserver = globalThis.MutationObserver;
	const activeLocaleObservers = new Set<MutationObserver>();
	class TrackedObserver extends originalObserver {
		observe(target: Node, options?: MutationObserverInit) {
			super.observe(target, options);
			if (
				target === document.documentElement &&
				options?.attributeFilter?.includes("style")
			) {
				activeLocaleObservers.add(this);
			}
		}
		disconnect() {
			activeLocaleObservers.delete(this);
			super.disconnect();
		}
	}
	globalThis.MutationObserver = TrackedObserver;
	const oldLocale =
		document.documentElement.style.getPropertyValue("--ryu-locale");
	const oldZone =
		document.documentElement.style.getPropertyValue("--ryu-timezone");
	document.documentElement.style.setProperty("--ryu-locale", "en-US");
	document.documentElement.style.setProperty(
		"--ryu-timezone",
		"Pacific/Kiritimati"
	);
	try {
		await act(async () => {
			root.render(
				<DateCell
					cell={cell}
					columnId="date"
					isActiveSearchMatch={false}
					isEditing={false}
					isFocused={false}
					isSearchMatch={false}
					isSelected={false}
					readOnly
					rowHeight="short"
					rowIndex={0}
					tableMeta={{}}
				/>
			);
		});
		const content = () =>
			container.querySelector('[data-slot="grid-cell-content"]')?.textContent;
		expect(content()).toBe("1/15/2026");
		await act(async () => {
			document.documentElement.style.setProperty("--ryu-locale", "de-DE");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(content()).toBe("15.1.2026");
		expect(records).toEqual([{ date: "2026-01-15", unrelated: "retained" }]);
		expect(activeLocaleObservers.size).toBe(1);
	} finally {
		await act(async () => {
			root.unmount();
		});
		expect(activeLocaleObservers.size).toBe(0);
		globalThis.MutationObserver = originalObserver;
		container.remove();
		for (const [name, value] of [
			["--ryu-locale", oldLocale],
			["--ryu-timezone", oldZone],
		]) {
			if (value) {
				document.documentElement.style.setProperty(name, value);
			} else {
				document.documentElement.style.removeProperty(name);
			}
		}
	}
});

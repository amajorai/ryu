import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkbenchItem } from "@ryu/workbench/model";
import { act, type ReactNode, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DesktopWorkbenchProvider,
	type DesktopWorkbenchValue,
	useDesktopWorkbench,
} from "./DesktopWorkbenchContext.tsx";
import { WorkbenchItemHost } from "./WorkbenchItemHost.tsx";
import {
	useWorkbenchSlots,
	WorkbenchSlotProvider,
} from "./workbench-slots.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

// SAFETY: The actual installed ReactDOM act environment reads this optional
// global flag. This test writes the authored boolean true to that native hook;
// the declaration gap concerns only this flag, without asserting other globals
// or replacing the registered DOM/native React test environment.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROUTE_ITEM: WorkbenchItem = {
	closable: true,
	duplicable: true,
	id: "route-settings",
	pinned: false,
	preferredRegion: "center",
	scope: { kind: "window" },
	source: { kind: "route", path: "/settings" },
	title: "Settings",
};

let routeMounts = 0;

function StatefulRoute() {
	const [mountNumber, setMountNumber] = useState(0);
	useEffect(() => {
		routeMounts += 1;
		setMountNumber(routeMounts);
	}, []);
	const [value, setValue] = useState("");
	return (
		<>
			<output data-testid="mount-count">{mountNumber}</output>
			<input
				onInput={(event) => setValue(event.currentTarget.value)}
				value={value}
			/>
		</>
	);
}

function RegisteredSlot({
	groupId,
	itemId,
}: {
	groupId: string;
	itemId: string;
}) {
	const { registerSlot, unregisterSlot } = useWorkbenchSlots();
	const setRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (element) {
				registerSlot(groupId, itemId, element);
				return;
			}
			const previous = document.querySelector(
				`[data-test-slot="${groupId}:${itemId}"]`
			);
			if (previous instanceof HTMLDivElement) {
				unregisterSlot(groupId, itemId, previous);
			}
		},
		[groupId, itemId, registerSlot, unregisterSlot]
	);
	return <div data-test-slot={`${groupId}:${itemId}`} ref={setRef} />;
}

function ActiveSlots() {
	const { state } = useDesktopWorkbench();
	return state.groups.flatMap((group) =>
		group.activeItemId
			? [
					<RegisteredSlot
						groupId={group.id}
						itemId={group.activeItemId}
						key={`${group.id}:${group.activeItemId}`}
					/>,
				]
			: []
	);
}

describe("WorkbenchItemHost", () => {
	let container: HTMLDivElement;
	let root: Root;
	let workbench: DesktopWorkbenchValue | undefined;

	function Probe({ children }: { children?: ReactNode }) {
		workbench = useDesktopWorkbench();
		return children ?? null;
	}

	beforeEach(() => {
		localStorage.clear();
		routeMounts = 0;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		workbench = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("keeps route state mounted while moving through workbench regions", async () => {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchSlotProvider>
						<Probe>
							<ActiveSlots />
							<WorkbenchItemHost
								renderItem={(item) =>
									item.source.kind === "route" ? <StatefulRoute /> : null
								}
							/>
						</Probe>
					</WorkbenchSlotProvider>
				</DesktopWorkbenchProvider>
			);
		});

		await act(async () => {
			workbench?.openItem(ROUTE_ITEM, { region: "center" });
		});
		expect(
			container.querySelector('[data-testid="mount-count"]')?.textContent
		).toBe("1");
		const input = container.querySelector("input");
		expect(input).not.toBeNull();
		await act(async () => {
			if (input) {
				input.value = "kept";
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});

		await act(async () => {
			workbench?.dispatch({ type: "region/show", region: "right" });
			workbench?.moveItem(ROUTE_ITEM.id, { region: "right" });
		});
		await act(async () => {
			workbench?.moveItem(ROUTE_ITEM.id, { region: "left" });
		});

		expect(container.querySelector("input")?.value).toBe("kept");
		expect(
			container.querySelector('[data-testid="mount-count"]')?.textContent
		).toBe("1");
	});
});

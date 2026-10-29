import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { TrayRefreshButton } = await import("./TrayPopover.tsx");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe("TrayRefreshButton", () => {
	test("is a visible button that runs the panel refresh", async () => {
		let calls = 0;
		await act(async () => {
			root.render(
				<TrayRefreshButton
					onRefresh={() => {
						calls += 1;
					}}
				/>
			);
		});
		const button = container.querySelector("button");
		expect(button?.textContent).toBe("Refresh");
		expect(button?.type).toBe("button");

		await act(async () => {
			button?.click();
			await Promise.resolve();
		});
		expect(calls).toBe(1);
		expect(button?.textContent).toBe("Refreshing…");
		expect(button?.disabled).toBe(true);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 650));
		});
		expect(button?.textContent).toBe("Refresh");
		expect(button?.disabled).toBe(false);
	});
});

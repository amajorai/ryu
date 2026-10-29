import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import BrandOrCoverImage from "./brand-image.tsx";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

test("failed raster art replaces the broken image and retries a changed source", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<BrandOrCoverImage
					fallback={<span>P</span>}
					light="https://fixture.invalid/first.png"
				/>
			)
		);
		const first = container.querySelector("img");
		expect(first).not.toBeNull();
		await act(async () => first?.dispatchEvent(new Event("error")));
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toBe("P");
		await act(async () =>
			root.render(
				<BrandOrCoverImage
					fallback={<span>P</span>}
					light="https://fixture.invalid/second.png"
				/>
			)
		);
		expect(container.querySelector("img")?.getAttribute("src")).toBe(
			"https://fixture.invalid/second.png"
		);
		expect(container.textContent).toBe("");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

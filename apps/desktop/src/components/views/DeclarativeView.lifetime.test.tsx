import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ViewSpec } from "@ryu/app-host/views";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DeclarativeView } from "./DeclarativeView.tsx";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

test("source replacement, refresh and unmount cancel reads and ignore late results", async () => {
	const container = document.createElement("div");
	const root = createRoot(container);
	const requests: {
		path: string;
		signal?: AbortSignal;
		resolve: <TValue>(value: TValue) => void;
	}[] = [];
	const fetchJson = (_method: string, path: string, signal?: AbortSignal) =>
		new Promise<unknown>((resolve) => {
			requests.push({ path, signal, resolve });
		});
	const spec = (path: string): ViewSpec => ({
		view: "list-detail",
		items: [],
		source: { http: { path } },
	});
	const first = spec("/api/first");
	const second = spec("/api/second");
	try {
		await act(async () => {
			root.render(<DeclarativeView fetchJson={fetchJson} spec={first} />);
		});
		expect(requests).toHaveLength(1);
		await act(async () => {
			root.render(<DeclarativeView fetchJson={fetchJson} spec={second} />);
		});
		expect(requests[0].signal?.aborted).toBe(true);
		expect(requests[1].path).toBe("/api/second");
		await act(async () => {
			requests[1].resolve([{ id: "current", title: "Current result" }]);
			requests[0].resolve([{ id: "old", title: "Stale result" }]);
		});
		expect(container.textContent).toContain("Current result");
		expect(container.textContent).not.toContain("Stale result");
		await act(async () => {
			root.render(
				<DeclarativeView fetchJson={fetchJson} reloadToken={1} spec={second} />
			);
		});
		expect(requests[1].signal?.aborted).toBe(true);
		expect(requests).toHaveLength(3);
		await act(async () => {
			root.render(null);
		});
		expect(requests[2].signal?.aborted).toBe(true);
		await act(async () => requests[2].resolve([]));
		expect(container.textContent).toBe("");
	} finally {
		await act(async () => root.unmount());
	}
});

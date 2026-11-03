import { expect, test } from "bun:test";
import { act } from "react";
import {
	live,
	mount,
	registerShortcutOverridesHooks,
	setNodeTabOverride,
	settle,
	useNodeStore,
} from "./usePluginShortcutOverrides.http.test-support.tsx";
import { fixture } from "./usePluginShortcutOverrides.http-fixture.test-support.ts";

registerShortcutOverridesHooks();

test("mounted node shortcut writes and resets preserve disk records, surface refusals and survive independent remount", async () => {
	const host = fixture();
	await mount();
	await settle(() => !live.latest.disabled);
	const original = host.raw("a");
	const foreign = host.raw("b");
	host.refuse(true);
	await act(async () => live.latest.save("shared", "Control+Alt+R"));
	expect(live.container?.textContent).toContain(
		"Couldn't update plugin shortcut"
	);
	expect(live.container?.querySelector("output")?.textContent).toContain(
		"Control+Alt+A"
	);
	expect(host.raw("a")).toBe(original);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+A");
	host.refuse(false);
	await act(async () => live.latest.save("shared", "Control+Alt+R"));
	expect(JSON.parse(host.raw("a"))).toEqual({
		"plugin:shared": "Control+Alt+R",
		"chat.new": "Control+N",
		"plugin:other": null,
	});
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+R");
	expect(host.raw("b")).toBe(foreign);
	await act(async () => live.root?.unmount());
	live.root = undefined;
	live.container?.remove();
	await mount();
	await settle(() => !live.latest.disabled);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+R");
	host.refuse(true);
	await act(async () => live.latest.save("shared", undefined));
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+R");
	host.refuse(false);
	await act(async () => live.latest.save("shared", undefined));
	expect(JSON.parse(host.raw("a"))).toEqual({
		"chat.new": "Control+N",
		"plugin:other": null,
	});
	expect(host.raw("b")).toBe(foreign);
	expect(
		host.calls.filter((c) => c.method === "POST").map((c) => c.admitted)
	).toEqual([false, true, false, true]);
});

test("malformed initial and externally corrupted native shortcut documents refuse writes and recover explicitly", async () => {
	const host = fixture();
	host.store("a", '{"plugin:shared":42}');
	await mount();
	await settle(() => live.latest.error);
	expect(live.latest.disabled).toBe(true);
	await act(async () => live.latest.save("shared", "Control+R"));
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	host.store("a", '{"plugin:shared":"Control+A","chat.new":"Control+N"}');
	await act(async () => live.latest.retry());
	expect(live.latest.disabled).toBe(false);
	host.store("a", "{broken");
	await act(async () => live.latest.save("shared", "Control+R"));
	// Core refuses to edit a document that is not a JSON object, and says so.
	expect(host.raw("a")).toBe("{broken");
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+A");
	expect(live.container?.textContent).toContain(
		"Couldn't update plugin shortcut"
	);
	expect(host.calls.filter((c) => c.method === "POST")).toMatchObject([
		{ authority: "a", admitted: false },
	]);
});

test("a write whose node changed in flight lands on the node it was sent to and never repaints the editor, and unmount retires a held initial read", async () => {
	const host = fixture();
	await mount();
	await settle(() => !live.latest.disabled);
	host.holdWrite();
	let pending: Promise<void> | undefined;
	await act(async () => {
		pending = live.latest.save("shared", "Control+R");
	});
	await settle(() => host.held());
	await act(async () => {
		host.select("b");
		host.select("a");
	});
	host.release();
	await act(async () => pending);
	// The request had already gone to node A, so Core applied it there; the
	// editor, which moved on, does not show that result.
	expect(host.calls.filter((c) => c.method === "POST")).toMatchObject([
		{ authority: "a", admitted: true },
	]);
	expect(JSON.parse(host.raw("a"))["plugin:shared"]).toBe("Control+R");
	expect(live.latest.overrides["plugin:shared"]).not.toBe("Control+R");
	await act(async () => live.latest.retry());
	await settle(() => !live.latest.disabled);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+R");
	await act(async () => live.latest.save("shared", "Control+C"));
	expect(JSON.parse(host.raw("a"))["plugin:shared"]).toBe("Control+C");
	await act(async () => live.root?.unmount());
	live.root = undefined;
	live.container?.remove();
	host.hold();
	await mount();
	await settle(() => host.held());
	await act(async () => live.root?.unmount());
	live.root = undefined;
	live.container?.remove();
	host.select("b");
	host.release();
	await act(async () => host.settled());
	await mount();
	await settle(() => !live.latest.disabled);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+B");
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(2);
});

test("foreign node credentials disable the mounted editor until the selected node reloads with current authority", async () => {
	const host = fixture();
	host.select("b");
	const current = useNodeStore.getState().nodes[0];
	if (!current) {
		throw new Error("Expected the selected fixture node");
	}
	const foreign = { ...current, token: "token-a" };
	useNodeStore.setState({ nodes: [foreign], localNodes: [foreign] });
	const first = host.raw("a");
	const second = host.raw("b");
	await mount();
	await settle(() => live.latest.error);
	expect(live.latest.disabled).toBe(true);
	await act(async () => live.latest.save("shared", "Control+Z"));
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	expect(host.raw("a")).toBe(first);
	expect(host.raw("b")).toBe(second);
	await act(async () => host.select("b"));
	await settle(() => !live.latest.disabled);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+B");
	await act(async () => live.latest.save("shared", "Control+Y"));
	expect(host.raw("a")).toBe(first);
	expect(JSON.parse(host.raw("b"))).toEqual({
		"plugin:shared": "Control+Y",
		"chat.new": "Control+B",
	});
	expect(host.calls.filter((c) => c.method === "POST")).toMatchObject([
		{ authority: "b", admitted: true },
	]);
});

test("a newer same-node reload remains authoritative after an older acknowledged read completes", async () => {
	const host = fixture();
	await mount();
	await settle(() => !live.latest.disabled);
	host.hold();
	let retired: Promise<void> | undefined;
	await act(async () => {
		retired = live.latest.retry();
	});
	await settle(() => host.held());
	const fresh = {
		"plugin:shared": "Control+Fresh",
		"chat.new": "Control+N",
		"plugin:other": null,
	};
	host.store("a", JSON.stringify(fresh));
	await act(async () => live.latest.retry());
	expect(live.latest.overrides).toEqual(fresh);
	expect(live.latest.disabled).toBe(false);
	host.release();
	await act(async () => retired);
	expect(live.latest.overrides).toEqual(fresh);
	expect(live.latest.disabled).toBe(false);
	expect(live.container?.querySelector("output")?.textContent).toContain(
		"Control+Fresh"
	);
	expect(host.calls.filter((c) => c.method === "POST")).toHaveLength(0);
	expect(JSON.parse(host.raw("a"))).toEqual(fresh);
});

test("changing per-tab node resolution does not retire its acknowledged load on an unrelated store notification", async () => {
	const host = fixture();
	const first = useNodeStore.getState().nodes[0];
	if (!first) {
		throw new Error("Expected fixture node A");
	}
	const second = {
		...first,
		name: "b",
		url: first.url.replace(/\/a$/, "/b"),
		token: "token-b",
	};
	useNodeStore.setState({
		nodes: [first, second],
		localNodes: [first, second],
		tabOverrides: { "plugin-test-tab": "b" },
	});
	setNodeTabOverride(true);
	await mount("plugin-test-tab");
	await settle(() => !live.latest.disabled);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+B");
	const unrelated = host.raw("b");
	host.hold();
	await act(async () => setNodeTabOverride(false));
	await settle(() => host.held());
	await act(async () => useNodeStore.setState({ autoSelect: false }));
	host.release();
	await settle(() => !live.latest.disabled);
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Alt+A");
	await act(async () => live.latest.save("shared", "Control+Resolved"));
	expect(JSON.parse(host.raw("a"))).toEqual({
		"plugin:shared": "Control+Resolved",
		"chat.new": "Control+N",
		"plugin:other": null,
	});
	expect(host.raw("b")).toBe(unrelated);
	expect(host.calls.filter((call) => call.method === "POST")).toMatchObject([
		{ authority: "a", admitted: true },
	]);
});

test("an acknowledged B editor can save independently while a retired A write remains held", async () => {
	const host = fixture();
	await mount();
	await settle(() => !live.latest.disabled);
	const first = host.raw("a");
	host.holdWrite();
	let retired: Promise<void> | undefined;
	await act(async () => {
		retired = live.latest.save("shared", "Control+Retired");
	});
	await settle(() => host.held());
	try {
		await act(async () => host.select("b"));
		await settle(
			() => live.latest.overrides["plugin:shared"] === "Control+Alt+B"
		);
		expect(live.latest.disabled).toBe(false);
		await act(async () => live.latest.save("shared", "Control+Independent"));
		expect(JSON.parse(host.raw("b"))).toEqual({
			"plugin:shared": "Control+Independent",
			"chat.new": "Control+B",
		});
		expect(host.raw("a")).toBe(first);
		expect(host.calls.filter((call) => call.method === "POST")).toMatchObject([
			{ authority: "a", admitted: false },
			{ authority: "b", admitted: true },
		]);
	} finally {
		host.release();
		await act(async () => retired);
	}
	// The held write was already addressed to A, which applies it on release;
	// the B editor neither shows it nor loses its own result.
	expect(JSON.parse(host.raw("a"))["plugin:shared"]).toBe("Control+Retired");
	expect(live.latest.overrides["plugin:shared"]).toBe("Control+Independent");
	expect(live.latest.disabled).toBe(false);
});

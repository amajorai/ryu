import { beforeEach, expect, test } from "bun:test";
import { pageLabel, pageRoute } from "@/src/lib/page-routes.ts";
import { useSidePanelRouteStore } from "./useSidePanelRouteStore.ts";

beforeEach(() => {
	useSidePanelRouteStore.getState().clear();
});

test("openPage refuses keys outside the page vocabulary and leaves the pending request untouched", () => {
	const store = useSidePanelRouteStore.getState();
	expect(store.openPage("spaces")).toBe(true);
	const before = useSidePanelRouteStore.getState().pending;
	for (const key of [
		"/settings",
		"javascript:alert(1)",
		"https://evil.example/",
		"toString",
		"constructor",
		"__proto__",
		"",
		"Settings",
	]) {
		expect(useSidePanelRouteStore.getState().openPage(key)).toBe(false);
		expect(useSidePanelRouteStore.getState().pending).toBe(before);
	}
});

test("openPage queues the allowlisted route under its page label", () => {
	expect(useSidePanelRouteStore.getState().openPage("settings")).toBe(true);
	const pending = useSidePanelRouteStore.getState().pending;
	expect(pageRoute("settings")).toBe("/settings");
	expect(pending?.kind).toBe("route:/settings");
	expect(pending?.label).toBe(pageLabel("settings"));
	expect(useSidePanelRouteStore.getState().openPage("spaces")).toBe(true);
	expect(useSidePanelRouteStore.getState().pending?.kind).toBe(
		"route:/library/space"
	);
});

test("openPath refuses non-dockable routes without queueing anything", () => {
	for (const path of [
		"/pane",
		"//evil.example/x",
		"javascript:alert(1)",
		"settings",
		"",
	]) {
		expect(useSidePanelRouteStore.getState().openPath(path)).toBe(false);
		expect(useSidePanelRouteStore.getState().pending).toBeNull();
	}
	expect(useSidePanelRouteStore.getState().openPath("/vault")).toBe(true);
	expect(useSidePanelRouteStore.getState().pending).toMatchObject({
		kind: "route:/vault",
		label: "/vault",
	});
	expect(useSidePanelRouteStore.getState().openPath("/vault", "Secrets")).toBe(
		true
	);
	expect(useSidePanelRouteStore.getState().pending?.label).toBe("Secrets");
});

test("repeating the same page bumps the nonce so the dock refocuses, and clear resets pending", () => {
	const store = useSidePanelRouteStore.getState();
	store.openPage("vault");
	const first = useSidePanelRouteStore.getState().pending;
	store.openPage("vault");
	const second = useSidePanelRouteStore.getState().pending;
	expect(second?.kind).toBe(first?.kind ?? "missing");
	expect(second).not.toBe(first);
	expect(second?.nonce ?? 0).toBeGreaterThan(first?.nonce ?? 0);
	store.clear();
	expect(useSidePanelRouteStore.getState().pending).toBeNull();
});

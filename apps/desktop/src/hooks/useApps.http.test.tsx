import { expect, test } from "bun:test";
import { act } from "react";
import {
	live,
	mount,
	queryClient,
	registerUseAppsHooks,
	settle,
} from "./useApps.http.test-support.ts";
import { fixture } from "./useApps.http-fixture.test-support.ts";

registerUseAppsHooks();

test("a delayed A refusal cannot publish its error into B after B independently acknowledges a toggle", async () => {
	const host = fixture();
	await mount();
	await settle(() => live.latest.apps[0]?.name === "shared a");
	const first = host.raw("a");
	const originalB = host.read("b");
	host.holdA();
	let retired: ReturnType<typeof live.latest.toggle> | undefined;
	await act(async () => {
		retired = live.latest.toggle("shared", false);
	});
	await settle(() => host.held());
	try {
		await act(async () => host.select("b"));
		await settle(() => live.latest.apps[0]?.name === "shared b");
		await act(async () => {
			expect(await live.latest.toggle("shared", false)).toEqual({
				success: true,
			});
		});
		expect(host.read("b")).toEqual([
			{ ...originalB[0], enabled: false },
			originalB[1],
		]);
		expect(host.raw("a")).toBe(first);
		host.release();
		await act(async () => {
			expect(await retired).toEqual({
				error: "Gateway unreachable (fail-closed): A mutation refused",
				success: false,
			});
		});
		expect(live.latest.toggleError).toBeNull();
		expect(live.container?.textContent).not.toContain("A mutation refused");
		expect(
			live.latest.apps.map(({ id, enabled }) => ({ id, enabled }))
		).toEqual([
			{ id: "shared", enabled: false },
			{ id: "unrelated", enabled: true },
		]);
		expect(host.raw("a")).toBe(first);
		expect(host.mutations).toEqual([
			{
				authority: "a",
				method: "POST",
				path: "/api/plugins/shared/disable",
				admitted: false,
			},
			{
				authority: "b",
				method: "POST",
				path: "/api/plugins/shared/disable",
				admitted: true,
			},
		]);
	} finally {
		host.release();
		await act(async () => retired);
	}
});

test("B's own refusal survives a late A error, then explicit B retry and independent reload preserve unrelated records", async () => {
	const host = fixture();
	await mount();
	await settle(() => live.latest.apps[0]?.name === "shared a");
	const first = host.raw("a");
	const second = host.raw("b");
	host.holdA();
	let retired: ReturnType<typeof live.latest.toggle> | undefined;
	await act(async () => {
		retired = live.latest.toggle("shared", false);
	});
	await settle(() => host.held());
	try {
		await act(async () => host.select("b"));
		await settle(() => live.latest.apps[0]?.name === "shared b");
		host.refuseB(true);
		await act(async () => {
			expect(await live.latest.toggle("shared", false)).toEqual({
				error: "Gateway unreachable (fail-closed): B mutation refused",
				success: false,
			});
		});
		expect(live.latest.toggleError).toBe(
			"Gateway unreachable (fail-closed): B mutation refused"
		);
		expect(host.raw("b")).toBe(second);
		expect(live.latest.apps[0]?.enabled).toBe(true);
		host.release();
		await act(async () => retired);
		expect(live.latest.toggleError).toBe(
			"Gateway unreachable (fail-closed): B mutation refused"
		);
		expect(live.container?.textContent).toContain("B mutation refused");
		expect(live.container?.textContent).not.toContain("A mutation refused");
		await act(async () => live.latest.clearToggleError());
		expect(live.latest.toggleError).toBeNull();
		host.refuseB(false);
		await act(async () => {
			expect(await live.latest.toggle("shared", false)).toEqual({
				success: true,
			});
		});
		expect(host.raw("a")).toBe(first);
		expect(host.read("b")[1]).toEqual(JSON.parse(second)[1]);
		await act(async () => host.settled());
		await act(async () => live.root?.unmount());
		live.root = undefined;
		live.container?.remove();
		queryClient.clear();
		await mount();
		await settle(
			() => live.latest.apps[0]?.name === "shared b" && !live.latest.loading
		);
		expect(live.latest.apps[0]?.enabled).toBe(false);
		expect(live.latest.toggleError).toBeNull();
		expect(
			host.mutations.map(({ authority, admitted }) => ({ authority, admitted }))
		).toEqual([
			{ authority: "a", admitted: false },
			{ authority: "b", admitted: false },
			{ authority: "b", admitted: true },
		]);
	} finally {
		host.release();
		await act(async () => retired);
	}
});

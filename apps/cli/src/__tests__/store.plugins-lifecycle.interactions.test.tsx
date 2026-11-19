/* @jsxImportSource @opentui/react */
// Store Plugins lifecycle through Core: install, toggle, update, uninstall,
// refresh, the narrow-pane uninstall prompt, and the dependents cascade retry.

import { expect, test } from "bun:test";
import {
	activeSection,
	currentSetup,
	installResponse,
	isStoreInputFocused,
	mountStore,
	press,
	registerStoreHarnessHooks,
	renderStore,
	waitFor,
} from "./store-interactions.harness.tsx";

registerStoreHarnessHooks();

function pluginWire(installed: boolean, enabled: boolean) {
	return {
		built_in: false,
		enabled,
		id: "plugin-one",
		installed,
		installed_version: installed ? "1.0.0" : null,
		local_only: false,
		name: "Lifecycle plugin",
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
		version: "1.1.0",
		windows_first: false,
	};
}

test("Store Plugins install, toggle, update, uninstall, and refresh through Core lifecycle actions", async () => {
	let installed = false;
	let enabled = false;
	let reads = 0;
	const actions: string[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (
			url.pathname === "/api/plugins" &&
			(!init?.method || init.method === "GET")
		) {
			reads += 1;
			return new Response(
				JSON.stringify({ apps: [pluginWire(installed, enabled)] }),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}
		if (url.pathname.startsWith("/api/plugins/plugin-one/")) {
			const action = url.pathname.split("/").at(-1) ?? "";
			actions.push(action);
			if (action === "install") {
				installed = true;
				enabled = false;
			} else if (action === "enable") {
				enabled = true;
			} else if (action === "disable") {
				enabled = false;
			} else if (action === "uninstall") {
				installed = false;
				enabled = false;
				return new Response(
					JSON.stringify({ success: true, removed: "plugin-one" }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					}
				);
			}
			return new Response(
				JSON.stringify({
					app: {
						id: "plugin-one",
						version: "1.1.0",
						enabled,
						approved_grants: [],
						created_at: null,
						updated_at: null,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}
		return new Response("not found", { status: 404 });
	});

	await renderStore();
	const setup = currentSetup();
	expect(
		await waitFor(setup, (frame) => frame.includes("available"))
	).toContain("Lifecycle plugin");

	await press(setup, "i");
	await waitFor(setup, (frame) => frame.includes("disabled"));
	await press(setup, "e");
	await waitFor(setup, (frame) => frame.includes("enabled"));
	await press(setup, "e");
	await waitFor(setup, (frame) => frame.includes("disabled"));
	await press(setup, "u");
	await waitFor(
		setup,
		() => actions.filter((action) => action === "update").length === 1
	);
	await press(setup, "D");
	await waitFor(setup, (frame) =>
		frame.includes("Uninstall Lifecycle plugin?")
	);
	expect(actions).not.toContain("uninstall");
	await press(setup, "y");
	await waitFor(setup, (frame) => frame.includes("available"));
	await press(setup, "r");
	await waitFor(setup, () => reads >= 7);

	expect(actions).toEqual([
		"install",
		"enable",
		"disable",
		"update",
		"uninstall",
	]);
	expect(reads).toBeGreaterThanOrEqual(7);
});

test("Store keeps the Plugins uninstall prompt open on arrows and / and fits a narrow pane", async () => {
	const posts: string[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (init?.method === "POST") {
			posts.push(url.pathname);
			return Response.json({ success: true, removed: "plugin-one" });
		}
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [pluginWire(true, true)] });
		}
		return new Response("not found", { status: 404 });
	});
	// 56 columns is what the Store gets beside the sidebar in an 80x24 terminal.
	const setup = await mountStore(56, 22);
	await waitFor(setup, (frame) => frame.includes("Lifecycle plugin"));

	await press(setup, "D");
	await waitFor(setup, (frame) =>
		frame.includes("Uninstall Lifecycle plugin?")
	);
	// The arrows move button focus inside the prompt instead of switching the
	// Store section (which would silently drop the pending uninstall), and /
	// does not steal focus into the search box.
	await press(setup, "right");
	await press(setup, "/");
	const frame = await waitFor(setup, (current) =>
		current.includes("Uninstall Lifecycle plugin?")
	);
	expect(activeSection(setup)).toBe("Plugins");
	expect(isStoreInputFocused()).toBe(false);
	// The buttons stay whole on one line and the prompt replaces the tab's
	// key-hint footer, so nothing overlaps the Store hint line below it.
	expect(frame).toMatch(/\[ Cancel \] \[ Uninstall \]/);
	expect(frame).not.toContain("e enable/disable");
	expect(frame).toContain("/ search");
	expect(posts).toEqual([]);

	// → moved focus to Uninstall, so Enter confirms.
	await press(setup, "return");
	await waitFor(setup, () => posts.length === 1);
	expect(posts).toEqual(["/api/plugins/plugin-one/uninstall"]);
	// With the prompt closed the Store owns the arrows again.
	await press(setup, "right");
	await waitFor(setup, (current) => current.includes("/api/catalog"));
});

test("Store Plugins offer C after a dependent refusal and retry the uninstall with cascade", async () => {
	const actions: string[] = [];
	let reads = 0;
	let enabled = true;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (
			url.pathname === "/api/plugins" &&
			(!init?.method || init.method === "GET")
		) {
			reads += 1;
			return new Response(
				JSON.stringify({ apps: [pluginWire(true, enabled)] }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				}
			);
		}
		if (
			url.pathname === "/api/plugins/plugin-one/disable" ||
			url.pathname === "/api/plugins/plugin-one/uninstall"
		) {
			const verb = url.pathname.endsWith("/disable") ? "disable" : "uninstall";
			const cascade = url.searchParams.get("cascade") === "true";
			actions.push(`${verb}:${cascade}`);
			if (url.searchParams.get("cascade") !== "true") {
				return new Response(
					JSON.stringify({
						message: "blocked",
						dependency_error: {
							code: "blocked_by_dependents",
							plugin: "plugin-one",
							dependents: ["dependent"],
						},
					}),
					{ status: 409, headers: { "content-type": "application/json" } }
				);
			}
			if (verb === "disable") {
				enabled = false;
				return new Response(
					JSON.stringify({
						app: {
							id: "plugin-one",
							version: "1.0.0",
							enabled,
							approved_grants: [],
							created_at: null,
							updated_at: null,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			return new Response(
				JSON.stringify({ success: true, removed: "plugin-one" }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				}
			);
		}
		return new Response("not found", { status: 404 });
	});

	await renderStore();
	const setup = currentSetup();
	await waitFor(setup, (frame) => frame.includes("enabled"));
	await press(setup, "e");
	await waitFor(setup, (frame) =>
		frame.includes("Press C to disable its dependents too")
	);
	await press(setup, "C");
	await waitFor(setup, (frame) => frame.includes("and its dependents?"));
	await press(setup, "y");
	await waitFor(setup, (frame) => frame.includes("disabled") && reads >= 2);
	await press(setup, "D");
	await press(setup, "y");
	await waitFor(setup, (frame) =>
		frame.includes("Press C to uninstall its dependents too")
	);
	await press(setup, "C");
	await waitFor(setup, (frame) => frame.includes("and its dependents?"));
	expect(actions).toHaveLength(3);
	await press(setup, "y");
	await waitFor(setup, () => actions.length === 4 && reads >= 3);

	expect(actions).toEqual([
		"disable:false",
		"disable:true",
		"uninstall:false",
		"uninstall:true",
	]);
});

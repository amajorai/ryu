/* @jsxImportSource @opentui/react */

import { afterEach, expect, test } from "bun:test";
import { KeyEvent, TextAttributes } from "@opentui/core";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "../core/ChatIntentContext.tsx";
import { ContributionsProvider } from "../core/ContributionsContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import {
	InputFocusProvider,
	useInputFocused,
} from "../core/InputFocusContext.tsx";
import { OverlayProvider } from "../overlays/OverlayHost.tsx";
import { STORE_SECTIONS } from "../surfaces/store/sections.ts";
import { ryuTheme } from "../ui/theme.ts";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { resolveSurface } from "../workspace/router.ts";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

// The SDK engine activation publisher sends exactly the complete name envelope.
const engineActivationFields = z.looseObject({ name: z.string() });
const engineActivationObservation = z.custom<
	z.infer<typeof engineActivationFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		engineActivationFields.safeParse(value).success
);
interface StoreActionObservation {
	body: z.infer<typeof appResponseValueSchema>;
	path: string;
}
function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
let testSetup: Awaited<ReturnType<typeof testRender>> | null = null;
let storeInputFocused = false;

function CaptureFocus() {
	storeInputFocused = useInputFocused();
	return null;
}

function StorePane() {
	const { focusedPaneId } = useWorkspace();
	const surface = resolveSurface("/store");
	if (!surface) {
		return null;
	}
	const Store = surface.Component;
	return <Store active={true} paneId={focusedPaneId} />;
}

function Harness() {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={LOCAL_TARGET}>
				<ContributionsProvider>
					<InputFocusProvider>
						<ToastProvider>
							<ChatIntentProvider>
								<WorkspaceProvider>
									<OverlayProvider>
										<CaptureFocus />
										<StorePane />
										<ToastHost />
									</OverlayProvider>
								</WorkspaceProvider>
							</ChatIntentProvider>
						</ToastProvider>
					</InputFocusProvider>
				</ContributionsProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		testSetup?.renderer.destroy();
		await Promise.resolve();
	});
	testSetup = null;
	storeInputFocused = false;
});

async function press(
	setup: Awaited<ReturnType<typeof testRender>>,
	name: string,
	ctrl = false,
	shift = false
): Promise<void> {
	if (name === "right" || name === "left") {
		await act(async () => {
			setup.mockInput.pressArrow(name);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await setup.flush({ maxPasses: 12 });
		return;
	}
	const keyInput = setup.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl,
				shift,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name.length === 1 ? name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await setup.renderOnce();
}

async function renderStore(width = 120): Promise<void> {
	testSetup = await testRender(<Harness />, { width, height: 36 });
	await waitFor(testSetup, (frame) => frame.includes("refresh"));
}

function currentSetup(): Awaited<ReturnType<typeof testRender>> {
	if (!testSetup) {
		throw new Error("Store renderer is not mounted");
	}
	return testSetup;
}

async function waitFor(
	setup: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let pass = 0; pass < 30 && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
		frame = setup.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Store render did not match: ${frame}`);
	}
	return frame;
}

function activeSection(
	setup: Awaited<ReturnType<typeof testRender>>
): string | undefined {
	const labels = new Set(STORE_SECTIONS.map((section) => section.label));
	for (const line of setup.captureSpans().lines) {
		for (const span of line.spans) {
			const label = span.text.trim();
			if (labels.has(label) && (span.attributes & TextAttributes.BOLD) !== 0) {
				return label;
			}
		}
	}
	return undefined;
}

test("left and right move through all Store sections and wrap at both ends", async () => {
	installResponse(
		async () =>
			new Response(JSON.stringify({ apps: [], runnables: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
	);
	await renderStore();
	const setup = currentSetup();

	expect(activeSection(setup)).toBe("Plugins");
	for (const section of STORE_SECTIONS.slice(1)) {
		await press(setup, "right");
		expect(activeSection(setup), setup.captureCharFrame()).toBe(section.label);
	}
	await press(setup, "right");
	expect(activeSection(setup)).toBe("Plugins");
	await press(setup, "left");
	expect(activeSection(setup)).toBe(STORE_SECTIONS.at(-1)?.label);
});

test("a narrow Store keeps the active section visible behind overflow markers", async () => {
	installResponse(
		async () =>
			new Response(JSON.stringify({ apps: [], runnables: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
	);
	await renderStore(50);
	const setup = currentSetup();
	const sectionRow = (frame: string) =>
		frame.split("\n").find((line) => line.includes("Plugins")) ??
		frame.split("\n").find((line) => line.includes("‹ +")) ??
		"";

	const first = await waitFor(setup, (frame) =>
		sectionRow(frame).includes("›")
	);
	expect(sectionRow(first)).toMatch(/\+\d+ ›/u);
	expect(sectionRow(first)).not.toContain("Fine-tune");

	// Left wraps to the last section, which must scroll into view.
	await press(setup, "left");
	const last = await waitFor(setup, (frame) =>
		sectionRow(frame).includes("Fine-tune")
	);
	expect(activeSection(setup)).toBe("Fine-tune");
	expect(sectionRow(last)).toMatch(/^‹ \+\d+/u);

	// Clicking the leading marker steps back to the nearest hidden section.
	const row = last.split("\n").findIndex((line) => line.startsWith("‹ +"));
	await act(async () => {
		await setup.mockMouse.click(0, row);
	});
	const hiddenBefore = Number(/^‹ \+(\d+)/u.exec(sectionRow(last))?.[1]);
	await waitFor(setup, () => activeSection(setup) !== "Fine-tune");
	expect(activeSection(setup)).toBe(STORE_SECTIONS[hiddenBefore - 1]?.label);
});

test("Store search tracks typed input and Enter opens the selected result realm", async () => {
	let modelReads = 0;
	installResponse(async (input) => {
		const url = String(input);
		let body: z.infer<typeof appRequestValueSchema> = {};
		if (url.endsWith("/api/plugins")) {
			body = {
				apps: [
					{
						id: "plugin-1",
						name: "Needle Plugin",
						version: "1",
						runnables: [],
					},
				],
				runnables: [],
			};
		} else if (url.endsWith("/api/catalog")) {
			body = { sidecars: [] };
		} else if (url.includes("/api/models/catalog")) {
			modelReads += 1;
			body = {
				data: [
					{ id: "model-1", name: "Needle Model", description: "catalog match" },
					{ id: "model-decoy", name: "Edle decoy", description: "suffix only" },
				],
			};
		} else if (url.includes("/api/skills/catalog")) {
			body = { skills: [] };
		} else if (url.includes("/api/tools/search")) {
			body = { data: [] };
		}
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	await renderStore();
	const setup = currentSetup();
	await act(async () => {
		await setup.mockInput.typeText("/");
	});
	await setup.flush({ maxPasses: 12 });
	await waitFor(setup, () => storeInputFocused);
	await act(async () => {
		await setup.mockInput.typeText("needle", 50);
	});
	const results = await waitFor(
		setup,
		(frame) => frame.includes("Needle Plugin") && frame.includes("Needle Model")
	);
	expect(results).not.toContain("Edle decoy");

	await press(setup, "escape");
	await waitFor(setup, () => !storeInputFocused);
	await press(setup, "r");
	await waitFor(setup, () => modelReads >= 2);
	await press(setup, "k");
	await press(setup, "down");
	await press(setup, "up");
	await press(setup, "j");
	await press(setup, "return");
	await waitFor(setup, () => activeSection(setup) === "Models");
	expect(activeSection(setup)).toBe("Models");
});

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
	testSetup = await testRender(<Harness />, { width: 56, height: 22 });
	const setup = testSetup;
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
	expect(storeInputFocused).toBe(false);
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
		frame.includes("press C to disable dependents too")
	);
	await press(setup, "C");
	await waitFor(setup, (frame) => frame.includes("and its dependents?"));
	await press(setup, "y");
	await waitFor(setup, (frame) => frame.includes("disabled") && reads >= 2);
	await press(setup, "D");
	await press(setup, "y");
	await waitFor(setup, (frame) =>
		frame.includes("press C to uninstall dependents too")
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

test("Store Sidecars install and uninstall the selected catalog item", async () => {
	let installed = false;
	let catalogReads = 0;
	const actions: string[] = [];
	installResponse(async (input, _init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/plugins") {
			return new Response(JSON.stringify({ apps: [], runnables: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/api/catalog") {
			catalogReads += 1;
			return new Response(
				JSON.stringify({
					sidecars: [
						{
							name: "ollama",
							category: "provider",
							install_state: installed ? "installed" : "available",
							installed_version: installed ? "1.0.0" : null,
							latest_version: "1.0.0",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } }
			);
		}
		if (url.pathname === "/api/setup/ollama/install") {
			actions.push("install");
			installed = true;
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/api/setup/ollama/uninstall") {
			actions.push("uninstall");
			installed = false;
			return new Response(null, { status: 204 });
		}
		return new Response("not found", { status: 404 });
	});

	await renderStore();
	const setup = currentSetup();
	await press(setup, "right");
	await waitFor(
		setup,
		(frame) => frame.includes("ollama") && catalogReads >= 1
	);
	await press(setup, "i");
	await waitFor(setup, (frame) => frame.includes("[✓]") && catalogReads >= 2);
	await press(setup, "d", false, true);
	await waitFor(setup, (frame) => frame.includes("Uninstall ollama?"));
	expect(actions).toEqual(["install"]);
	await press(setup, "y");
	await waitFor(setup, (_frame) => actions.length === 2 && catalogReads >= 3);
	expect(setup.captureCharFrame()).not.toContain("[✓]");

	expect(actions).toEqual(["install", "uninstall"]);
	expect(catalogReads).toBeGreaterThanOrEqual(3);
});

test("Store Models and Skills install and activate the selected catalog items", async () => {
	const actions: StoreActionObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (init?.method === "POST") {
			actions.push({
				body: init.body
					? appResponseValueSchema.parse(JSON.parse(String(init.body)))
					: null,
				path: url.pathname,
			});
			if (url.pathname === "/api/skills/catalog/install") {
				return Response.json({
					success: true,
					result: { slug: "skill-one", path: "/skills/skill-one" },
				});
			}
			return Response.json({ success: true, active: "model-one" });
		}
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [], runnables: [] });
		}
		if (url.pathname === "/api/models/catalog") {
			return Response.json({ data: [{ id: "model-one", name: "Model One" }] });
		}
		if (url.pathname === "/api/skills/catalog") {
			return Response.json({
				skills: [{ id: "skill-one", name: "Skill One" }],
			});
		}
		return Response.json({});
	});
	await renderStore();
	const setup = currentSetup();
	await press(setup, "right");
	await press(setup, "right");
	await waitFor(setup, (frame) => frame.includes("Model One"));
	await press(setup, "return");
	await waitFor(setup, () =>
		actions.some((action) => action.path === "/api/models/catalog/install")
	);
	await press(setup, "a");
	await waitFor(setup, () =>
		actions.some((action) => action.path === "/api/models/active")
	);

	await press(setup, "right");
	await waitFor(setup, (frame) => frame.includes("Skill One"));
	await press(setup, "return");
	await waitFor(setup, () =>
		actions.some((action) => action.path === "/api/skills/catalog/install")
	);
	await press(setup, "a");
	await waitFor(setup, () =>
		actions.some((action) => action.path === "/api/skills/activate")
	);

	expect(actions).toContainEqual({
		path: "/api/models/catalog/install",
		body: { id: "model-one" },
	});
	expect(actions).toContainEqual({
		path: "/api/models/active",
		body: { id: "model-one" },
	});
	expect(actions).toContainEqual({
		path: "/api/skills/catalog/install",
		body: { id: "skill-one" },
	});
	expect(actions).toContainEqual({
		path: "/api/skills/activate",
		body: { id: "skill-one", active: true },
	});
});

test("Store Engines navigate and persist the selected engine through Core", async () => {
	let active = "Alpha engine";
	let engineReads = 0;
	let activationBody: z.infer<typeof engineActivationObservation> | undefined;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [], runnables: [] });
		}
		if (url.pathname === "/api/engines") {
			engineReads += 1;
			return Response.json({
				engines: [
					{ id: "engine-alpha", name: "Alpha engine", installed: true },
					{ id: "engine-beta", name: "Beta engine", installed: true },
				],
			});
		}
		if (url.pathname === "/api/engine/active" && init?.method === "POST") {
			activationBody = engineActivationObservation.parse(
				JSON.parse(String(init.body))
			);
			active = String(activationBody.name);
			return Response.json({ active, running: true, gateway_refreshed: true });
		}
		if (url.pathname === "/api/engine/active") {
			return Response.json({ active, running: true, available: [] });
		}
		return Response.json({});
	});
	await renderStore();
	const setup = currentSetup();
	for (let index = 0; index < 6; index += 1) {
		await press(setup, "right");
	}
	await waitFor(
		setup,
		(frame) => frame.includes("Alpha engine") && frame.includes("Beta engine")
	);
	await press(setup, "j");
	await press(setup, "return");
	const activated = await waitFor(
		setup,
		(frame) =>
			frame.includes("active:") &&
			frame.includes("Beta engine") &&
			active === "Beta engine"
	);
	expect(activated).toContain("Beta engine");
	expect(activationBody).toEqual({ name: "Beta engine" });
	await press(setup, "r");
	await waitFor(setup, () => engineReads >= 3);
});

test("Store Agents select a configured agent, load its detail, and refresh the list", async () => {
	let listReads = 0;
	const detailReads: string[] = [];
	installResponse(async (input) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/plugins") {
			return Response.json({ apps: [], runnables: [] });
		}
		if (url.pathname === "/api/agents") {
			listReads += 1;
			return Response.json({
				agents: [
					{ id: "agent-alpha", name: "Alpha Agent", engine: "claude" },
					{ id: "agent-beta", name: "Beta Agent", engine: "mock" },
				],
			});
		}
		if (url.pathname === "/api/agents/agent-beta") {
			detailReads.push(url.pathname);
			return Response.json({
				agent: {
					id: "agent-beta",
					name: "Beta Agent",
					engine: "mock",
					model: "beta-model",
					tools: ["search", "shell"],
					version: "1.0.0",
				},
			});
		}
		return Response.json({});
	});
	await renderStore();
	const setup = currentSetup();
	for (let index = 0; index < 5; index += 1) {
		await press(setup, "right");
	}
	await waitFor(
		setup,
		(frame) => frame.includes("Alpha Agent") && frame.includes("Beta Agent")
	);
	await press(setup, "j");
	await press(setup, "return");
	const details = await waitFor(
		setup,
		(frame) => detailReads.length === 1 && frame.includes("search")
	);
	expect(details).toContain("search");
	await press(setup, "r");
	await waitFor(setup, () => listReads >= 2);
	expect(detailReads).toEqual(["/api/agents/agent-beta"]);
});

/* @jsxImportSource @opentui/react */
// Store sections, search, and the catalog surfaces (Sidecars, Models, Skills,
// Engines, Agents). Plugins lifecycle and cascade flows live in
// store.plugins-lifecycle.interactions.test.tsx.

import { expect, test } from "bun:test";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { STORE_SECTIONS } from "../surfaces/store/sections.ts";
import {
	activeSection,
	currentSetup,
	installResponse,
	isStoreInputFocused,
	press,
	registerStoreHarnessHooks,
	renderStore,
	type StoreActionObservation,
	waitFor,
} from "./store-interactions.harness.tsx";

registerStoreHarnessHooks();

// The SDK engine activation publisher sends exactly the complete name envelope.
const engineActivationFields = z.looseObject({ name: z.string() });
const engineActivationObservation = z.custom<
	z.infer<typeof engineActivationFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		engineActivationFields.safeParse(value).success
);

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
	await waitFor(setup, () => isStoreInputFocused());
	await act(async () => {
		await setup.mockInput.typeText("needle", 50);
	});
	const results = await waitFor(
		setup,
		(frame) => frame.includes("Needle Plugin") && frame.includes("Needle Model")
	);
	expect(results).not.toContain("Edle decoy");

	await press(setup, "escape");
	await waitFor(setup, () => !isStoreInputFocused());
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

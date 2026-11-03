import { expect, test } from "bun:test";
import { act } from "react";
import {
	button,
	captureWrites,
	choose,
	hasRow,
	mount,
	policyWrites,
	registerShadowControlsHooks,
	rowDescription,
	rowInput,
	rowTrigger,
	save,
	section,
	settle,
	type,
	unmount,
	until,
} from "./ShadowSettings.controls.test-support.tsx";
import {
	baselineCapture,
	capture,
	functionGemma,
	initialPolicy,
	initialPreferences,
	layaRouter,
	persistedPreferences,
	savedPolicy,
	setEnabledPlugins,
	setPlanners,
	writePolicy,
} from "./ShadowSettings.controls-peer.test-support.ts";

// Control-level cases for the ShadowSettings rows; the native Core peer, the
// store IPC fixture and the mount helpers live in the support modules.
registerShadowControlsHooks();

test("Keep history commits on focus loss and always shows the window Shadow keeps, for clamped and empty entries, across remount", async () => {
	await mount();
	const retention = rowInput("Keep history");
	expect(retention.getAttribute("aria-label")).toBe(
		"Shadow history retention in days"
	);
	expect(retention.value).toBe("30");
	const before = captureWrites().length;
	const commit = async (typed: string, sent: number, writes: number) => {
		await type(rowInput("Keep history"), typed);
		expect(captureWrites()).toHaveLength(before + writes - 1);
		await act(async () => rowInput("Keep history").blur());
		await until(
			() => captureWrites().length === before + writes,
			`Leaving Keep history with ${JSON.stringify(typed)} did not commit`
		);
		await settle();
		expect(captureWrites().at(-1)?.body).toEqual({
			history_retention_days: sent,
		});
		expect(capture).toEqual({
			...baselineCapture,
			history_retention_days: sent,
		});
		expect(persistedPreferences()).toEqual({
			...initialPreferences,
			shadow_history_retention_days: sent,
		});
		expect(rowInput("Keep history").value).toBe(String(sent));
	};
	await commit("45", 45, 1);
	await commit("99999", 3650, 2);
	// Same accepted window again: the field must not keep the rejected text.
	await commit("5000", 3650, 3);
	await commit("", 3650, 4);
	await unmount();
	await mount();
	expect(rowInput("Keep history").value).toBe("3650");
	expect(captureWrites().at(-1)?.body).toEqual({
		...baselineCapture,
		history_retention_days: 3650,
	});
});

test("Planner switches Jev to Shadow model without a write until Save, then saves only the planner and a fresh mount reads it", async () => {
	await mount();
	const trigger = rowTrigger("Planner");
	expect(trigger.getAttribute("aria-label")).toBe(
		"Shadow computer-use planner"
	);
	expect(trigger.textContent).toContain("Jev Ultrafast");
	expect(hasRow("Jev endpoint")).toBe(true);
	await choose(trigger, "Shadow model");
	expect(rowTrigger("Planner").textContent).toContain("Shadow model");
	expect(hasRow("Jev endpoint")).toBe(false);
	expect(hasRow("Jev model")).toBe(false);
	expect(policyWrites()).toHaveLength(0);
	expect(savedPolicy().planner).toBe("jev");
	const write = await save();
	expect(write?.body).toEqual({ ...initialPolicy, planner: "native" });
	expect(write?.status).toBe(200);
	expect(savedPolicy()).toEqual({ ...initialPolicy, planner: "native" });
	expect(section("Computer use").textContent).toContain(
		"Computer-use settings saved; they will apply when Shadow starts."
	);
	await unmount();
	await mount();
	expect(rowTrigger("Planner").textContent).toContain("Shadow model");
	expect(hasRow("Jev endpoint")).toBe(false);
	await choose(rowTrigger("Planner"), "Jev Ultrafast");
	expect(rowInput("Jev endpoint").value).toBe(initialPolicy.jevUrl);
	expect(rowInput("Jev model").value).toBe(initialPolicy.jevModel);
	expect(policyWrites()).toHaveLength(1);
});

test("Action limit's own input never sends a non-number: a cleared entry keeps the last valid limit and Save persists the next valid one", async () => {
	await mount();
	const limit = rowInput("Action limit");
	expect(limit.getAttribute("aria-label")).toBe("Maximum computer-use steps");
	expect(limit.value).toBe("7");
	await type(limit, "");
	expect(rowInput("Action limit").value).toBe("7");
	await type(rowInput("Action limit"), "15");
	expect(rowInput("Action limit").value).toBe("15");
	const write = await save();
	expect(write?.body).toEqual({ ...initialPolicy, maxSteps: 15 });
	expect(savedPolicy().maxSteps).toBe(15);
	await unmount();
	await mount();
	expect(rowInput("Action limit").value).toBe("15");
});

test("Jev endpoint and model: Core's HTTPS refusal keeps the draft and the saved file; the corrected endpoint and model save together and reload", async () => {
	await mount();
	const endpoint = rowInput("Jev endpoint");
	expect(endpoint.getAttribute("aria-label")).toBe("Jev decision endpoint URL");
	expect(endpoint.value).toBe(initialPolicy.jevUrl);
	expect(rowInput("Jev model").getAttribute("aria-label")).toBe(
		"Jev model identifier"
	);
	await type(endpoint, "http://jev.example.test/v1/decide");
	const refused = await save();
	expect(refused?.status).toBe(400);
	expect(refused?.body).toEqual({
		...initialPolicy,
		jevUrl: "http://jev.example.test/v1/decide",
	});
	const alert = section("Computer use").querySelector('[role="alert"]');
	expect(alert?.textContent).toContain(
		"Computer-use settings could not be saved"
	);
	expect(alert?.textContent).toContain(
		"computer-use endpoints require HTTPS; HTTP is loopback-only"
	);
	expect(rowInput("Jev endpoint").value).toBe(
		"http://jev.example.test/v1/decide"
	);
	expect(savedPolicy()).toEqual(initialPolicy);
	await type(
		rowInput("Jev endpoint"),
		"https://jev-two.example.test/v2/decide"
	);
	await type(rowInput("Jev model"), "jev-ultrafast-2");
	const accepted = await save();
	expect(accepted?.status).toBe(200);
	expect(accepted?.body).toEqual({
		...initialPolicy,
		jevUrl: "https://jev-two.example.test/v2/decide",
		jevModel: "jev-ultrafast-2",
	});
	expect(section("Computer use").querySelector('[role="alert"]')).toBeNull();
	expect(savedPolicy()).toEqual({
		...initialPolicy,
		jevUrl: "https://jev-two.example.test/v2/decide",
		jevModel: "jev-ultrafast-2",
	});
	await unmount();
	await mount();
	expect(rowInput("Jev endpoint").value).toBe(
		"https://jev-two.example.test/v2/decide"
	);
	expect(rowInput("Jev model").value).toBe("jev-ultrafast-2");
});

test("Local model lists enabled plugin models, preselects the first, saves the chosen plugin/model pair and reloads it", async () => {
	setPlanners([functionGemma, layaRouter]);
	setEnabledPlugins(new Set([functionGemma.plugin, layaRouter.plugin]));
	await mount();
	expect(hasRow("Local model")).toBe(false);
	await choose(rowTrigger("Planner"), "Local model plugin");
	expect(hasRow("Jev endpoint")).toBe(false);
	const local = rowTrigger("Local model");
	expect(local.getAttribute("aria-label")).toBe("Local computer-use model");
	expect(local.textContent).toContain(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	expect(rowDescription("Local model")).toContain(
		"Options come from enabled model plugins."
	);
	await choose(local, "Laya router · @ryu/laya");
	expect(rowTrigger("Local model").textContent).toContain(
		"Laya router · @ryu/laya"
	);
	expect(policyWrites()).toHaveLength(0);
	const write = await save();
	expect(write?.status).toBe(200);
	expect(write?.body).toEqual({
		...initialPolicy,
		planner: "local",
		localPluginId: "@ryu/laya",
		localModelId: "router",
	});
	expect(savedPolicy()).toMatchObject({
		planner: "local",
		localPluginId: "@ryu/laya",
		localModelId: "router",
		jevUrl: initialPolicy.jevUrl,
		maxSteps: 7,
	});
	await unmount();
	await mount();
	expect(rowTrigger("Planner").textContent).toContain("Local model plugin");
	expect(rowTrigger("Local model").textContent).toContain(
		"Laya router · @ryu/laya"
	);
});

test("Local model marks a saved model no plugin advertises as unavailable and blocks Save; Core's disabled-plugin refusal keeps the saved choice", async () => {
	writePolicy({
		...initialPolicy,
		planner: "local",
		localPluginId: "@ryu/removed-planner",
		localModelId: "gone-model",
	});
	setPlanners([functionGemma]);
	setEnabledPlugins(new Set([functionGemma.plugin]));
	await mount();
	expect(rowTrigger("Local model").textContent).toContain(
		"Unavailable model · @ryu/removed-planner"
	);
	expect(button("Save computer-use settings").disabled).toBe(true);
	await act(async () => button("Save computer-use settings").click());
	expect(policyWrites()).toHaveLength(0);
	await choose(
		rowTrigger("Local model"),
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	expect(button("Save computer-use settings").disabled).toBe(false);
	// The plugin is disabled after Desktop listed it; Core re-checks on save.
	setEnabledPlugins(new Set());
	const refused = await save();
	expect(refused?.status).toBe(400);
	expect(section("Computer use").textContent).toContain(
		"enable the selected local model plugin before choosing it"
	);
	expect(savedPolicy()).toMatchObject({
		localPluginId: "@ryu/removed-planner",
		localModelId: "gone-model",
	});
	expect(rowTrigger("Local model").textContent).toContain(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	setEnabledPlugins(new Set([functionGemma.plugin]));
	const accepted = await save();
	expect(accepted?.status).toBe(200);
	expect(savedPolicy()).toMatchObject({
		planner: "local",
		localPluginId: functionGemma.plugin,
		localModelId: functionGemma.model_id,
	});
});

test("Local model without any enabled planner plugin explains how to add one and keeps Save disabled", async () => {
	await mount();
	await choose(rowTrigger("Planner"), "Local model plugin");
	expect(rowTrigger("Local model").textContent).toContain(
		"Choose an enabled plugin model"
	);
	expect(rowDescription("Local model")).toContain(
		"Install and enable a local computer-use model plugin"
	);
	expect(button("Save computer-use settings").disabled).toBe(true);
	await act(async () => button("Save computer-use settings").click());
	expect(policyWrites()).toHaveLength(0);
	expect(savedPolicy()).toEqual(initialPolicy);
});

test("Planner and Local model are keyboard operable: arrows move from the saved choice, Escape discards, Enter selects and returns focus to the trigger", async () => {
	setPlanners([functionGemma, layaRouter]);
	setEnabledPlugins(new Set([functionGemma.plugin, layaRouter.plugin]));
	await mount();
	const press = async (key: string) => {
		const target = document.activeElement;
		if (!target) {
			throw new Error("No focused element for keyboard input");
		}
		await act(async () => {
			target.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
			);
			target.dispatchEvent(
				new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true })
			);
		});
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
		});
	};
	const focused = () => (document.activeElement as HTMLElement | null) ?? null;
	const planner = rowTrigger("Planner");
	await act(async () => planner.focus());
	await press("ArrowDown");
	expect(planner.getAttribute("aria-expanded")).toBe("true");
	expect(focused()?.getAttribute("role")).toBe("option");
	expect(focused()?.textContent?.trim()).toBe("Jev Ultrafast");
	await press("ArrowUp");
	expect(focused()?.textContent?.trim()).toBe("Shadow model");
	await press("Escape");
	expect(planner.getAttribute("aria-expanded")).toBe("false");
	expect(planner.textContent).toContain("Jev Ultrafast");
	expect(hasRow("Jev endpoint")).toBe(true);
	await act(async () => planner.focus());
	await press("ArrowDown");
	await press("ArrowDown");
	expect(focused()?.textContent?.trim()).toBe("Local model plugin");
	await press("Enter");
	expect(planner.getAttribute("aria-expanded")).toBe("false");
	expect(focused()).toBe(planner);
	expect(planner.textContent).toContain("Local model plugin");
	const local = rowTrigger("Local model");
	expect(local.textContent).toContain(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	await act(async () => local.focus());
	await press("ArrowDown");
	expect(focused()?.textContent?.trim()).toBe(
		"FunctionGemma 270M · @ryu/functiongemma"
	);
	await press("ArrowDown");
	await press("Enter");
	expect(focused()).toBe(local);
	expect(local.textContent).toContain("Laya router · @ryu/laya");
	expect(policyWrites()).toHaveLength(0);
	const write = await save();
	expect(write?.body).toEqual({
		...initialPolicy,
		planner: "local",
		localPluginId: layaRouter.plugin,
		localModelId: layaRouter.model_id,
	});
	expect(savedPolicy().localPluginId).toBe(layaRouter.plugin);
});

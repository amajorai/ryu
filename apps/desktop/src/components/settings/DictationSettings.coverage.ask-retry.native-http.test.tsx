import { expect, test } from "bun:test";
import { act } from "react";
import {
	agentReads,
	alertMessage,
	captionFor,
	choose,
	click,
	container,
	DEFAULT_DICTATION_ASK_PROMPT,
	DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	labelled,
	mount,
	mountLoaded,
	parseDictationPrefs,
	pickAgent,
	puts,
	putValues,
	registerDictationCoverageHooks,
	remount,
	required,
	rowTitles,
	seed,
	settled,
	stored,
	text,
	type,
	until,
} from "./DictationSettings.coverage.test-support.tsx";
import {
	arm,
	calls,
	DICTATION_PATH,
	EMPTY_SELECTION,
	holdNextPutTo,
	releaseHeld,
	SPEECH_PATH,
	store,
} from "./DictationSettings.coverage-peer.test-support.ts";

// Control-level cases for the shipping DictationSettings tab; the Core-shaped
// preference peer and the mount helpers live in the support modules.
registerDictationCoverageHooks();

test("Agent ask reveals its shortcut, activation, agent and prompt; the picked agent opens its access panel and wins over the cleanup agent", async () => {
	seed({
		postProcess: {
			enabled: true,
			prompt: DEFAULT_DICTATION_POSTPROCESS_PROMPT,
			selection: { ...EMPTY_SELECTION, agent_id: "dictation-editor" },
		},
	});
	await mountLoaded();
	expect(captionFor("Agent ask")).toBe(
		"Hold the agent-ask shortcut, ask a question, and paste the agent's answer."
	);
	const enable = required("Enable agent ask");
	expect(enable.getAttribute("aria-checked")).toBe("false");
	for (const label of [
		"Set agent-ask shortcut",
		"Agent-ask activation mode",
		"Agent-ask agent or model",
		"Agent-ask prompt",
	]) {
		expect(labelled(label)).toBeNull();
	}
	// With agent ask off, the cleanup agent owns the access panel.
	await until(
		() => agentReads("dictation-editor").length === 1,
		"cleanup agent access panel"
	);
	expect(agentReads("dictation-scribe")).toHaveLength(0);

	await click(enable);
	await settled(1);
	expect(stored().ask.enabled).toBe(true);
	expect(rowTitles()).toEqual(
		expect.arrayContaining([
			"Agent-ask shortcut",
			"Activation",
			"Agent",
			"Ask prompt",
		])
	);
	expect(captionFor("Agent-ask shortcut")).toBe(
		"Global key for agent-ask. Kept separate from the dictation shortcut."
	);
	const activations = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].filter((title) => text(title) === "Activation");
	expect(activations).toHaveLength(2);
	// A flush settings row renders its description under its own title.
	const askActivationCaption = () => text(activations[1]!.nextElementSibling);
	expect(askActivationCaption()).toBe(
		"Hold the shortcut to record; release to ask and paste the answer."
	);
	await choose("Agent-ask activation mode", "Press to start / stop");
	await settled(2);
	expect(askActivationCaption()).toBe(
		"Press once to start, again to stop, ask, and paste the answer."
	);
	expect(stored().ask.mode).toBe("toggle");
	// The dictation activation is independent of the agent-ask one.
	expect(stored().mode).toBe("push-to-talk");

	expect(captionFor("Agent")).toBe(
		"Prefer an agent when you want tool access (Spaces, Ghost, other apps). A model-only pick answers without tools."
	);
	expect(text(required("Agent-ask agent or model"))).toBe(
		"Default local model"
	);
	await pickAgent("Agent-ask agent or model", "Scribe agent");
	await settled(3);
	expect(stored().ask.selection).toEqual({
		...EMPTY_SELECTION,
		agent_id: "dictation-scribe",
	});
	expect(text(required("Agent-ask agent or model"))).toBe("Scribe agent");
	// The ask agent now owns the access panel, ahead of the cleanup agent.
	await until(
		() => agentReads("dictation-scribe").length === 1,
		"ask agent access panel"
	);

	expect(captionFor("Ask prompt")).toBe(
		"Instructions for the ask agent. It sees this plus your spoken question."
	);
	const prompt = required<HTMLTextAreaElement>("Agent-ask prompt");
	expect(prompt.value).toBe(DEFAULT_DICTATION_ASK_PROMPT);
	// Typing re-renders the tab on every keystroke; the open access panel must
	// not reload the agent, its Spaces and its tools each time.
	const panelReads = () =>
		calls.filter(
			(call) =>
				call.method === "GET" &&
				[
					"/api/agents/dictation-scribe",
					"/api/spaces",
					"/api/mcp/tools",
				].includes(call.path)
		).length;
	const readsBeforeTyping = panelReads();
	await type(prompt, "A");
	await type(prompt, "Answer");
	await type(prompt, "Answer in one sentence.");
	await settled(6);
	expect(panelReads()).toBe(readsBeforeTyping);
	expect(stored().ask).toEqual({
		enabled: true,
		mode: "toggle",
		prompt: "Answer in one sentence.",
		selection: { ...EMPTY_SELECTION, agent_id: "dictation-scribe" },
		shortcut: "CommandOrControl+Shift+A",
	});
	expect(parseDictationPrefs(store.get("dictation") ?? null).ask).toEqual(
		stored().ask
	);
	// The cleanup agent was never touched by agent-ask writes.
	expect(stored().postProcess.selection.agent_id).toBe("dictation-editor");

	await remount();
	expect(required("Enable agent ask").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(text(required("Agent-ask activation mode"))).toBe(
		"Press to start / stop"
	);
	expect(required<HTMLTextAreaElement>("Agent-ask prompt").value).toBe(
		"Answer in one sentence."
	);
	await until(
		() => text(labelled("Agent-ask agent or model")) === "Scribe agent",
		"agent summary after remount"
	);
	// The remounted tab reopens the ask agent's access panel from Core.
	await until(
		() => agentReads("dictation-scribe").length === 2,
		"ask agent panel after remount"
	);

	// Turning agent ask off hides its rows, keeps its values, and hands the
	// access panel back to the cleanup agent.
	const scribeReads = agentReads("dictation-scribe").length;
	const editorReads = agentReads("dictation-editor").length;
	await click(required("Enable agent ask"));
	await settled(7);
	expect(labelled("Agent-ask prompt")).toBeNull();
	expect(stored().ask).toMatchObject({
		enabled: false,
		prompt: "Answer in one sentence.",
	});
	await until(
		() => agentReads("dictation-editor").length === editorReads + 1,
		"cleanup agent panel returns"
	);
	expect(agentReads("dictation-scribe")).toHaveLength(scribeReads);
});

test("a failed load offers Retry; refused saves keep the edit, name the failed preference, and Retry save writes the identical blob; queued writes reach Core in order", async () => {
	seed({ pasteKeys: "", insertMode: "paste" });
	arm("GET", DICTATION_PATH, 503);
	await mount();
	await until(
		() => container.querySelector('[role="alert"]') !== null,
		"load failure"
	);
	expect(alertMessage()).toBe("Could not load Dictation settings.");
	expect(labelled("Set dictation shortcut")).toBeNull();
	await click(
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Retry"
		)!
	);
	await until(() => labelled("Set dictation shortcut") !== null, "retry load");
	expect(
		calls
			.filter((call) => call.method === "GET" && call.path === DICTATION_PATH)
			.map((call) => call.status)
	).toEqual([503, 200]);

	arm("PUT", DICTATION_PATH, 503);
	await click(required("Auto-send after dictation"));
	await until(
		() => alertMessage() === "Could not save Dictation settings.",
		"dictation save failure"
	);
	// The control keeps the user's change while the save is retried.
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("true");
	expect(stored().autoSend).toBe(false);
	await click(
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Retry save"
		)!
	);
	await settled(2);
	await until(
		() => container.querySelector('[role="alert"]') === null,
		"alert cleared"
	);
	expect(puts().map((call) => call.status)).toEqual([503, 200]);
	expect(putValues()[0]).toEqual(putValues()[1]);
	expect(stored().autoSend).toBe(true);

	arm("PUT", SPEECH_PATH, 500);
	await choose("Speech Processing engine", "S1-mini by Superwhisper");
	await until(
		() => alertMessage() === "Could not save Speech Processing settings.",
		"speech save failure"
	);
	expect(store.has("speech-processing")).toBe(false);
	await click(
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Retry save"
		)!
	);
	await settled(2, SPEECH_PATH);
	await until(
		() => container.querySelector('[role="alert"]') === null,
		"speech alert cleared"
	);
	expect(stored("speech-processing")).toEqual({
		context: "general",
		engine: "s1-mini",
		structure: "prose",
		styling: "semi-formal",
	});

	// Keystrokes queue behind a held write and land at Core in typing order,
	// never two at once, so the last keystroke is what Core keeps.
	holdNextPutTo(DICTATION_PATH);
	const pasteCommand = required<HTMLInputElement>("Paste command");
	await type(pasteCommand, "c");
	await until(() => releaseHeld !== null, "held write");
	await type(pasteCommand, "ct");
	await type(pasteCommand, "ctrl+v");
	// Give any unqueued write ample time to reach Core: none may, while the
	// first one is still unanswered.
	for (let tick = 0; tick < 20; tick += 1) {
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	expect(puts()).toHaveLength(3);
	expect(puts().filter((call) => call.status === 0)).toHaveLength(1);
	releaseHeld!();
	await settled(5);
	expect(
		putValues()
			.slice(2)
			.map((value) => (value as { pasteKeys: string }).pasteKeys)
	).toEqual(["c", "ct", "ctrl+v"]);
	expect(stored().pasteKeys).toBe("ctrl+v");
	expect(pasteCommand.value).toBe("ctrl+v");
});

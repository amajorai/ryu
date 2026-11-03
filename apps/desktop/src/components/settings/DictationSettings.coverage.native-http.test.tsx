import { expect, test } from "bun:test";
import { act } from "react";
import {
	captionFor,
	choose,
	click,
	container,
	DEFAULT_DICTATION_ASK_PROMPT,
	DEFAULT_DICTATION_POSTPROCESS_PROMPT,
	DEFAULT_DICTATION_PREFS,
	keycaps,
	labelled,
	mountLoaded,
	openSelect,
	parseDictationPrefs,
	pickCustomModel,
	press,
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
	VOICE_ENGINES,
} from "./DictationSettings.coverage.test-support.tsx";
import {
	EMPTY_SELECTION,
	SPEECH_PATH,
	store,
} from "./DictationSettings.coverage-peer.test-support.ts";

// Control-level cases for the shipping DictationSettings tab; the Core-shaped
// preference peer and the mount helpers live in the support modules.
registerDictationCoverageHooks();

test("Transcribe controls load the saved Core blob, write the complete blob on each change, and the island reads every choice back", async () => {
	seed({
		autoSend: false,
		engine: "whisper",
		insertMode: "type",
		mode: "toggle",
		pasteKeys: "",
		postProcess: {
			enabled: true,
			prompt: "Keep the speaker's jargon.",
			selection: EMPTY_SELECTION,
		},
		restoreClipboard: true,
		shortcut: "CommandOrControl+Alt+J",
	});
	await mountLoaded();

	// Every value comes from Core, not from the defaults.
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Alt", "J"]);
	expect(text(required("Dictation activation mode"))).toBe(
		"Press to start / stop"
	);
	expect(captionFor("Activation")).toBe(
		"Press once to start, again to stop and insert."
	);
	expect(text(required("Dictation engine"))).toBe("Whisper");
	expect(captionFor("Engine")).toBe(
		"Voice Recognition engine used for dictation."
	);
	expect(text(required("Dictation insertion method"))).toBe(
		"Type (synthetic keystrokes)"
	);
	expect(captionFor("Insertion")).toBe(
		"Types the text character by character. No clipboard clobber; works everywhere."
	);
	expect(labelled("Paste command")).toBeNull();
	expect(labelled("Restore clipboard after paste")).toBeNull();
	expect(captionFor("Auto-send (press Enter)")).toBe(
		"Press Enter after inserting, which sends the message in a chat box (or adds a newline in an editor)."
	);
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("false");
	expect(puts()).toHaveLength(0);

	await choose("Dictation activation mode", "Hold to talk");
	await settled(1);
	expect(captionFor("Activation")).toBe(
		"Hold the shortcut to record; release to insert."
	);
	expect(stored().mode).toBe("push-to-talk");

	// The engine list is the shipping VOICE_ENGINES set, in order.
	expect(await openSelect("Dictation engine")).toEqual(
		VOICE_ENGINES.map((entry) => entry.label)
	);
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await choose("Dictation engine", "audio.cpp");
	await settled(2);
	expect(stored().engine).toBe("audiocpp");

	await choose("Dictation insertion method", "Paste (clipboard)");
	await settled(3);
	expect(captionFor("Insertion")).toBe(
		"Copies the text and sends the paste shortcut, so it stays instant even for long dictations."
	);
	const pasteCommand = required<HTMLInputElement>("Paste command");
	// happy-dom reports a non-Windows user agent, so the macOS default is shown.
	expect(pasteCommand.placeholder).toBe("cmd+v (default)");
	expect(captionFor("Paste command")).toBe(
		"Key combo to paste, `+`-joined (e.g. ctrl+v, cmd+shift+v). Empty uses the platform default."
	);
	await type(pasteCommand, "ctrl+shift+v");
	await settled(4);
	expect(stored().pasteKeys).toBe("ctrl+shift+v");

	const restore = required("Restore clipboard after paste");
	expect(restore.getAttribute("aria-checked")).toBe("true");
	expect(captionFor("Restore clipboard")).toBe(
		"Put your previous clipboard back after pasting the dictation."
	);
	await click(restore);
	await settled(5);
	expect(stored().restoreClipboard).toBe(false);

	await click(required("Auto-send after dictation"));
	await settled(6);
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("true");

	// Each write carried the whole blob: the cleanup prompt, the shortcut and
	// the agent-ask defaults were never dropped, and `enabled` is stamped on.
	const expected = {
		...DEFAULT_DICTATION_PREFS,
		autoSend: true,
		enabled: true,
		engine: "audiocpp",
		insertMode: "paste",
		mode: "push-to-talk",
		pasteKeys: "ctrl+shift+v",
		postProcess: {
			enabled: true,
			prompt: "Keep the speaker's jargon.",
			selection: EMPTY_SELECTION,
		},
		restoreClipboard: false,
		shortcut: "CommandOrControl+Alt+J",
	};
	expect(stored()).toEqual(expected);
	for (const value of putValues()) {
		expect(value).toMatchObject({
			ask: { prompt: DEFAULT_DICTATION_ASK_PROMPT },
			enabled: true,
			postProcess: { prompt: "Keep the speaker's jargon." },
			shortcut: "CommandOrControl+Alt+J",
		});
	}
	expect(puts().every((call) => call.status === 200)).toBe(true);

	// The island companion's own parser reads the identical configuration.
	const island = parseDictationPrefs(store.get("dictation") ?? null);
	expect(island).toMatchObject({
		autoSend: true,
		engine: "audiocpp",
		insertMode: "paste",
		mode: "push-to-talk",
		pasteKeys: "ctrl+shift+v",
		restoreClipboard: false,
		shortcut: "CommandOrControl+Alt+J",
	});

	await remount();
	expect(text(required("Dictation activation mode"))).toBe("Hold to talk");
	expect(text(required("Dictation engine"))).toBe("audio.cpp");
	expect(text(required("Dictation insertion method"))).toBe(
		"Paste (clipboard)"
	);
	expect(required<HTMLInputElement>("Paste command").value).toBe(
		"ctrl+shift+v"
	);
	expect(
		required("Restore clipboard after paste").getAttribute("aria-checked")
	).toBe("false");
	expect(
		required("Auto-send after dictation").getAttribute("aria-checked")
	).toBe("true");

	// Switching back to typing hides the paste rows but keeps their saved values.
	await choose("Dictation insertion method", "Type (synthetic keystrokes)");
	await settled(7);
	expect(labelled("Paste command")).toBeNull();
	expect(labelled("Restore clipboard after paste")).toBeNull();
	expect(stored()).toMatchObject({
		insertMode: "type",
		pasteKeys: "ctrl+shift+v",
		restoreClipboard: false,
	});
});

test("dictation and agent-ask shortcuts are recorded from the keyboard; Escape, blur and bare modifiers write nothing, and Reset restores each default", async () => {
	seed({ ask: { ...DEFAULT_DICTATION_PREFS.ask, enabled: true } });
	await mountLoaded();
	const dictation = required("Set dictation shortcut");
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Shift", "D"]);

	await act(async () => {
		dictation.focus();
	});
	await click(dictation);
	expect(text(dictation)).toBe("Press keys…");
	expect(document.activeElement).toBe(dictation);
	// A bare modifier keeps composing; Escape cancels without a write.
	await press(dictation, "Control", { ctrlKey: true });
	expect(text(dictation)).toBe("Press keys…");
	await press(dictation, "Escape");
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Shift", "D"]);
	// Without capture armed, a chord is ignored.
	await press(dictation, "k", { altKey: true, ctrlKey: true });
	expect(puts()).toHaveLength(0);

	await click(dictation);
	await press(dictation, "k", { altKey: true, ctrlKey: true });
	await settled(1);
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Alt", "K"]);
	expect(stored().shortcut).toBe("CommandOrControl+Alt+K");

	// Blurring an armed capture drops it.
	await click(dictation);
	await act(async () => {
		dictation.dispatchEvent(new FocusEvent("blur"));
		dictation.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	});
	await press(dictation, "q", { ctrlKey: true });
	expect(puts()).toHaveLength(1);

	const ask = required("Set agent-ask shortcut");
	expect(keycaps("Set agent-ask shortcut")).toEqual(["Ctrl", "Shift", "A"]);
	await click(ask);
	await press(ask, " ", { ctrlKey: true, shiftKey: true });
	await settled(2);
	expect(keycaps("Set agent-ask shortcut")).toEqual(["Ctrl", "Shift", "Space"]);
	expect(stored().ask.shortcut).toBe("CommandOrControl+Shift+Space");
	expect(stored().shortcut).toBe("CommandOrControl+Alt+K");

	let island = parseDictationPrefs(store.get("dictation") ?? null);
	expect(island.shortcut).toBe("CommandOrControl+Alt+K");
	expect(island.ask.shortcut).toBe("CommandOrControl+Shift+Space");

	const resets = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].filter((button) => text(button) === "Reset");
	expect(resets).toHaveLength(2);
	await click(resets[0]!);
	await settled(3);
	expect(stored().shortcut).toBe("CommandOrControl+Shift+D");
	expect(stored().ask.shortcut).toBe("CommandOrControl+Shift+Space");
	await click(resets[1]!);
	await settled(4);
	island = parseDictationPrefs(store.get("dictation") ?? null);
	expect(island.shortcut).toBe("CommandOrControl+Shift+D");
	expect(island.ask.shortcut).toBe("CommandOrControl+Shift+A");

	await remount();
	expect(keycaps("Set dictation shortcut")).toEqual(["Ctrl", "Shift", "D"]);
	expect(keycaps("Set agent-ask shortcut")).toEqual(["Ctrl", "Shift", "A"]);
});

test("Clean up with Speech Processing gates the cleanup engine, override and prompt; the engine write keeps the node's other Speech Processing controls", async () => {
	seed({});
	const speech = {
		context: "email",
		engine: "s1-mini",
		structure: "lists",
		styling: "formal",
	};
	store.set("speech-processing", JSON.stringify(speech));
	await mountLoaded();

	expect(captionFor("Clean up with Speech Processing")).toBe(
		"Run the selected Speech Processing engine after Voice Recognition. Defaults to S1-mini by Superwhisper; turn this off to insert the raw transcript."
	);
	const cleanup = required("Clean up dictation with Speech Processing");
	expect(cleanup.getAttribute("aria-checked")).toBe("true");
	expect(text(required("Speech Processing engine"))).toBe(
		"S1-mini by Superwhisper"
	);
	expect(captionFor("Cleanup engine")).toBe(
		"The node-local cleanup model. Style, structure, and context are configured from the Speech Processing layer on the Computer dialog's Voice & sandbox page."
	);
	expect(captionFor("Custom cleanup override")).toBe(
		"Leave empty to use the selected Speech Processing engine. Pick an agent or model only for an explicit custom cleanup override."
	);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"Use Speech Processing engine"
	);
	expect(captionFor("Custom cleanup prompt")).toBe(
		"Used only when a custom cleanup agent/model is selected. S1-mini uses its required local control prompt."
	);
	expect(required<HTMLTextAreaElement>("Dictation cleanup prompt").value).toBe(
		DEFAULT_DICTATION_POSTPROCESS_PROMPT
	);

	await choose("Speech Processing engine", "S1-mini by Superwhisper");
	await settled(1, SPEECH_PATH);
	// The cleanup engine is its own preference and conserves the style,
	// structure and context the Computer dialog owns.
	expect(stored("speech-processing")).toEqual(speech);
	expect(puts()).toHaveLength(0);

	await pickCustomModel("Dictation cleanup agent or model", "cleanup-local");
	await settled(1);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"cleanup-local"
	);
	expect(stored().postProcess.selection).toEqual({
		...EMPTY_SELECTION,
		model: "cleanup-local",
	});

	await type(
		required<HTMLTextAreaElement>("Dictation cleanup prompt"),
		"Only fix punctuation."
	);
	await settled(2);
	expect(stored().postProcess).toEqual({
		enabled: true,
		prompt: "Only fix punctuation.",
		selection: { ...EMPTY_SELECTION, model: "cleanup-local" },
	});

	await click(cleanup);
	await settled(3);
	expect(labelled("Speech Processing engine")).toBeNull();
	expect(labelled("Dictation cleanup agent or model")).toBeNull();
	expect(labelled("Dictation cleanup prompt")).toBeNull();
	expect(rowTitles()).not.toContain("Custom cleanup prompt");
	// Turning cleanup off records the opt-out but keeps the override and prompt.
	expect(stored().postProcess).toEqual({
		enabled: false,
		prompt: "Only fix punctuation.",
		selection: { ...EMPTY_SELECTION, model: "cleanup-local" },
	});
	expect(
		parseDictationPrefs(store.get("dictation") ?? null).postProcess
	).toEqual({
		enabled: false,
		prompt: "Only fix punctuation.",
		selection: { ...EMPTY_SELECTION, model: "cleanup-local" },
	});

	await remount();
	expect(
		required("Clean up dictation with Speech Processing").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(labelled("Dictation cleanup prompt")).toBeNull();
	await click(required("Clean up dictation with Speech Processing"));
	await settled(4);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"cleanup-local"
	);
	expect(required<HTMLTextAreaElement>("Dictation cleanup prompt").value).toBe(
		"Only fix punctuation."
	);

	// "Use the default" clears the override back to the Speech Processing engine.
	await click(required("Dictation cleanup agent or model"));
	await until(
		() =>
			[...document.querySelectorAll("button")].some(
				(button) => text(button) === "Use the default"
			),
		"inherit row"
	);
	await click(
		[...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => text(button) === "Use the default"
		)!
	);
	await settled(5);
	expect(stored().postProcess.selection).toEqual(EMPTY_SELECTION);
	expect(text(required("Dictation cleanup agent or model"))).toBe(
		"Use Speech Processing engine"
	);
	expect(stored("speech-processing")).toEqual(speech);
});

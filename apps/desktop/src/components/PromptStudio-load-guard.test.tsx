import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { useState } = await import("react");
const { usePromptLoadGuard } = await import("./PromptStudio-load-guard.ts");

let root: Root | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
});

type Guard = ReturnType<typeof usePromptLoadGuard>;

/** Mounts the guard over a controlled draft, like PromptStudio's parent. */
function mount(initial: string, agentId = "agent-1") {
	const handle: {
		agent: (id: string) => void;
		draft: string;
		guard: Guard | null;
		/** What the editor does on input: report the value, then hand it up. */
		type: (next: string) => void;
	} = {
		agent: () => undefined,
		draft: initial,
		guard: null,
		type: () => undefined,
	};
	function Probe() {
		const [draft, setDraft] = useState(initial);
		const [agent, setAgent] = useState(agentId);
		handle.draft = draft;
		handle.agent = (id) => act(() => setAgent(id));
		const guard = usePromptLoadGuard(agent, draft, setDraft);
		handle.guard = guard;
		handle.type = (next) =>
			act(() => {
				guard.noteEditorValue(next);
				setDraft(next);
			});
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root?.render(<Probe />));
	return handle;
}

test("an untouched draft takes the durable suite's prompt", () => {
	const studio = mount("Saved prompt.");
	// Mounting re-reports the loaded text (with Markdown's trailing newline).
	act(() => studio.guard?.noteEditorValue("Saved prompt.\n"));
	act(() => studio.guard?.applyLoadedPrompt("Suite prompt."));
	expect(studio.draft).toBe("Suite prompt.");
});

test("an edit made before the suite arrives is not overwritten", () => {
	const studio = mount("Saved prompt.");
	studio.type("Saved prompt. My edit.");
	act(() => studio.guard?.applyLoadedPrompt("Suite prompt."));
	expect(studio.draft).toBe("Saved prompt. My edit.");
});

test("clearing the draft counts as an edit", () => {
	const studio = mount("Saved prompt.");
	studio.type("​\n");
	act(() => studio.guard?.applyLoadedPrompt("Suite prompt."));
	expect(studio.draft).toBe("​\n");
});

test("a draft loaded from outside is not mistaken for an edit", () => {
	const studio = mount("");
	act(() => studio.guard?.applyLoadedPrompt("Agent prompt."));
	studio.type("Agent prompt.\n");
	act(() => studio.guard?.applyLoadedPrompt("Suite prompt."));
	expect(studio.draft).toBe("Suite prompt.");
});

test("switching agents starts clean", () => {
	const studio = mount("Saved prompt.");
	studio.type("Edited.");
	studio.agent("agent-2");
	act(() => studio.guard?.applyLoadedPrompt("Second agent's suite."));
	expect(studio.draft).toBe("Second agent's suite.");
});

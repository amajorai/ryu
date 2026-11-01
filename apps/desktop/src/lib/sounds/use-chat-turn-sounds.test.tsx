import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { FakeAudioContext } = await import("./sound-audio-context.fixture.ts");
const { __resetSoundEngineForTests, __setSoundSinkForTests, markRunStopped } =
	await import("./play-sound.ts");
const { useChatTurnSounds } = await import("./use-chat-turn-sounds.ts");
type ChatTurnStatus = import("./use-chat-turn-sounds.ts").ChatTurnStatus;

const played: string[] = [];
const roots: Array<{ unmount: () => void }> = [];

function Turn({
	status,
	conversationId,
}: {
	status: ChatTurnStatus;
	conversationId: string | null;
}) {
	useChatTurnSounds(status, conversationId);
	return null;
}

function mountTurn(initial: ChatTurnStatus, conversationId: string | null) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	const render = (status: ChatTurnStatus, id: string | null = conversationId) =>
		act(() => {
			root.render(
				<StrictMode>
					<Turn conversationId={id} status={status} />
				</StrictMode>
			);
		});
	render(initial);
	return render;
}

beforeEach(() => {
	played.length = 0;
	__setSoundSinkForTests((id, options) => {
		played.push(options.key ? `${id}@${options.key}` : id);
	});
});

afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	__setSoundSinkForTests(null);
	__resetSoundEngineForTests();
});

describe("useChatTurnSounds", () => {
	it("plays message-sent then run-complete once for a full turn", () => {
		const render = mountTurn("ready", "c1");
		render("submitted");
		render("streaming");
		render("streaming");
		render("ready");
		render("ready");
		expect(played).toEqual(["message-sent", "run-complete@run:c1"]);
	});

	it("is silent on mount, including mounting mid-stream or errored", () => {
		mountTurn("ready", "c1");
		mountTurn("streaming", "c2");
		mountTurn("error", "c3");
		expect(played).toEqual([]);
	});

	it("plays run-failed when an in-flight turn errors", () => {
		const render = mountTurn("ready", "c1");
		render("submitted");
		render("error");
		render("ready");
		expect(played).toEqual(["message-sent", "run-failed@run:c1"]);
	});

	it("keys a draft's run by the id it gains mid-turn", () => {
		const render = mountTurn("ready", null);
		render("submitted", null);
		render("streaming", "new-id");
		render("ready", "new-id");
		expect(played).toEqual(["message-sent", "run-complete@run:new-id"]);
	});

	it("stays silent when the tab switches to another thread", () => {
		const render = mountTurn("streaming", "c1");
		render("ready", "c2");
		expect(played).toEqual([]);
	});
});

describe("useChatTurnSounds with the real engine", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
	const contexts: InstanceType<typeof FakeAudioContext>[] = [];

	beforeEach(() => {
		localStorage.clear();
		__setSoundSinkForTests(null);
		__resetSoundEngineForTests();
		contexts.length = 0;
		class Recording extends FakeAudioContext {
			constructor() {
				super("running");
				contexts.push(this);
			}
		}
		Object.defineProperty(globalThis, "AudioContext", {
			configurable: true,
			value: Recording,
		});
	});

	afterEach(() => {
		setSystemTime();
		if (original) {
			Object.defineProperty(globalThis, "AudioContext", original);
		} else {
			Reflect.deleteProperty(globalThis, "AudioContext");
		}
	});

	it("does not celebrate a run the user stopped", () => {
		const render = mountTurn("streaming", "stopped-conv");
		render("streaming");
		markRunStopped("stopped-conv");
		render("ready");
		expect(contexts.flatMap((ctx) => ctx.oscillators)).toHaveLength(0);
	});

	it("a Stop does not swallow the next turn's completion in that chat", () => {
		const start = new Date("2026-10-31T12:00:00Z").getTime();
		setSystemTime(start);
		const render = mountTurn("streaming", "requeued");
		markRunStopped("requeued");
		render("ready");
		expect(contexts.flatMap((ctx) => ctx.oscillators)).toHaveLength(0);
		// The queue force-sends the next message straight away.
		render("submitted");
		render("streaming");
		setSystemTime(start + 1500);
		render("ready");
		expect(contexts.flatMap((ctx) => ctx.oscillators).length).toBeGreaterThan(
			0
		);
	});

	it("plays the completion cue for a run that was not stopped", () => {
		const render = mountTurn("ready", "ok-conv");
		render("streaming");
		render("ready");
		expect(contexts.flatMap((ctx) => ctx.oscillators).length).toBeGreaterThan(
			0
		);
	});
});

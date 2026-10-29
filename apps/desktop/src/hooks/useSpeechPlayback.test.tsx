import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSpeechPlayback } from "./useSpeechPlayback.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const originalAudio = globalThis.Audio;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

const revokedUrls: string[] = [];
let nextUrl = 1;

class MockAudio extends EventTarget {
	static instances: MockAudio[] = [];
	static rejectNextPlay = false;

	readonly pause = mock(() => undefined);
	readonly play: ReturnType<typeof mock>;
	readonly src: string;

	constructor(src: string) {
		super();
		this.src = src;
		const rejectPlay = MockAudio.rejectNextPlay;
		MockAudio.rejectNextPlay = false;
		this.play = mock(async () => {
			if (rejectPlay) {
				throw new Error("play rejected");
			}
		});
		MockAudio.instances.push(this);
	}
}

Reflect.set(globalThis, "Audio", MockAudio);
Reflect.set(URL, "createObjectURL", (_blob: Blob) => `blob:test-${nextUrl++}`);
Reflect.set(URL, "revokeObjectURL", (url: string) => {
	revokedUrls.push(url);
});

afterAll(() => {
	Reflect.set(globalThis, "Audio", originalAudio);
	Reflect.set(URL, "createObjectURL", originalCreateObjectUrl);
	Reflect.set(URL, "revokeObjectURL", originalRevokeObjectUrl);
});

beforeEach(() => {
	MockAudio.instances = [];
	MockAudio.rejectNextPlay = false;
	revokedUrls.length = 0;
	nextUrl = 1;
});

async function mountPlayback() {
	let playback: ReturnType<typeof useSpeechPlayback> | null = null;
	function Harness() {
		playback = useSpeechPlayback();
		return null;
	}
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => {
		root.render(<Harness />);
	});
	const mountedPlayback = requirePlayback(playback);
	let mounted = true;
	return {
		playback: mountedPlayback,
		unmount: async () => {
			if (!mounted) {
				return;
			}
			mounted = false;
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

function requirePlayback(
	playback: ReturnType<typeof useSpeechPlayback> | null
): ReturnType<typeof useSpeechPlayback> {
	if (!playback) {
		throw new Error("Speech playback hook did not mount");
	}
	return playback;
}

const blob = () => Promise.resolve(new Blob(["speech"]));

describe("useSpeechPlayback", () => {
	test("disposes before replacement and ignores stale callbacks", async () => {
		const mounted = await mountPlayback();
		expect(await mounted.playback.play("first", blob)).toBe("playing");
		const first = MockAudio.instances[0];
		expect(await mounted.playback.play("second", blob)).toBe("playing");
		const second = MockAudio.instances[1];

		expect(first?.pause).toHaveBeenCalledTimes(1);
		expect(revokedUrls).toEqual(["blob:test-1"]);
		first?.dispatchEvent(new Event("ended"));
		expect(second?.pause).not.toHaveBeenCalled();
		expect(revokedUrls).toEqual(["blob:test-1"]);

		await mounted.unmount();
		expect(second?.pause).toHaveBeenCalledTimes(1);
		expect(revokedUrls).toEqual(["blob:test-1", "blob:test-2"]);
	});

	test("toggles the same active key off without synthesizing again", async () => {
		const mounted = await mountPlayback();
		await mounted.playback.play("same", blob);
		const createAgain = mock(blob);

		expect(await mounted.playback.play("same", createAgain)).toBe("stopped");
		expect(createAgain).not.toHaveBeenCalled();
		expect(MockAudio.instances[0]?.pause).toHaveBeenCalledTimes(1);
		expect(revokedUrls).toEqual(["blob:test-1"]);
		await mounted.unmount();
	});

	test("disposes on ended and error events", async () => {
		const mounted = await mountPlayback();
		await mounted.playback.play("ended", blob);
		MockAudio.instances[0]?.dispatchEvent(new Event("ended"));
		expect(revokedUrls).toEqual(["blob:test-1"]);

		await mounted.playback.play("error", blob);
		MockAudio.instances[1]?.dispatchEvent(new Event("error"));
		expect(revokedUrls).toEqual(["blob:test-1", "blob:test-2"]);
		await mounted.unmount();
	});

	test("disposes when play rejects", async () => {
		const mounted = await mountPlayback();
		MockAudio.rejectNextPlay = true;

		await expect(mounted.playback.play("rejected", blob)).rejects.toThrow(
			"play rejected"
		);
		await Promise.resolve();
		expect(MockAudio.instances[0]?.pause).toHaveBeenCalledTimes(1);
		expect(revokedUrls).toEqual(["blob:test-1"]);
		await mounted.unmount();
	});

	test("disposes when output-device preparation rejects", async () => {
		const mounted = await mountPlayback();
		const prepareAudio = mock(async () => {
			throw new Error("speaker rejected");
		});

		await expect(
			mounted.playback.play("prepare", blob, { prepareAudio })
		).rejects.toThrow("speaker rejected");
		await Promise.resolve();
		expect(MockAudio.instances[0]?.play).not.toHaveBeenCalled();
		expect(MockAudio.instances[0]?.pause).toHaveBeenCalledTimes(1);
		expect(revokedUrls).toEqual(["blob:test-1"]);
		await mounted.unmount();
	});

	test("disposes active playback on unmount", async () => {
		const mounted = await mountPlayback();
		await mounted.playback.play("active", blob);
		await mounted.unmount();

		expect(MockAudio.instances[0]?.pause).toHaveBeenCalledTimes(1);
		expect(revokedUrls).toEqual(["blob:test-1"]);
	});

	test("drops a late synthesis result after unmount without creating a URL", async () => {
		const mounted = await mountPlayback();
		let resolveBlob: (value: Blob) => void = () => undefined;
		const pendingBlob = new Promise<Blob>((resolve) => {
			resolveBlob = resolve;
		});
		const pending = mounted.playback.play("pending", () => pendingBlob);

		await mounted.unmount();
		resolveBlob(new Blob(["late"]));
		expect(await pending).toBe("superseded");
		expect(MockAudio.instances).toHaveLength(0);
		expect(revokedUrls).toHaveLength(0);
	});
});

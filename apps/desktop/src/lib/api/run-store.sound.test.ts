import { afterEach, expect, test } from "bun:test";
import type { RunSummary } from "@/src/hooks/useRuns.ts";
import {
	__resetSoundEngineForTests,
	__setSoundSinkForTests,
	playSound,
	type SoundCallKind,
} from "../sounds/play-sound.ts";
import { FakeAudioContext } from "../sounds/sound-audio-context.fixture.ts";
import type { PlaySoundOptions } from "../sounds/sound-engine.ts";
import { subscribeRuns } from "./run-store.ts";

interface RecordedCue {
	id: string;
	options: PlaySoundOptions & { kind: SoundCallKind };
}

function run(id: string, status: string): RunSummary {
	return {
		agent_id: null,
		branch: null,
		created_at: 1,
		folder_path: null,
		id,
		message_count: 1,
		run_status: status,
		title: "Fixture run",
		updated_at: 1,
		worktree_path: null,
	};
}

function sse(frames: unknown[]): string {
	return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

afterEach(() => {
	__setSoundSinkForTests(null);
});

async function recordCues(
	frames: unknown[]
): Promise<{ changes: number; cues: RecordedCue[] }> {
	const cues: RecordedCue[] = [];
	__setSoundSinkForTests((id, options) => {
		cues.push({ id, options });
	});
	const changes = await streamFrames(frames);
	return { changes, cues };
}

async function streamFrames(frames: unknown[]): Promise<number> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse(frames)));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	});
	let changes = 0;
	const unsubscribe = subscribeRuns(
		{ url: server.url.toString(), token: "fixture", userJwt: "fixture" },
		() => {
			changes++;
		},
		(source) => source
	);
	try {
		const deadline = Date.now() + 2000;
		while (changes < frames.length && Date.now() < deadline) {
			await Bun.sleep(5);
		}
		return changes;
	} finally {
		unsubscribe();
		server.stop(true);
	}
}

test("a background run finishing plays run-complete keyed by its conversation", async () => {
	const { changes, cues } = await recordCues([
		{ type: "snapshot", runs: [run("conv-1", "running")] },
		{ type: "run", run: run("conv-1", "completed") },
	]);
	expect(changes).toBe(2);
	expect(cues).toEqual([
		{
			id: "run-complete",
			options: { key: "run:conv-1", kind: "play", source: "stream" },
		},
	]);
});

test("a background run failing plays run-failed with the same dedupe key", async () => {
	const { changes, cues } = await recordCues([
		{ type: "snapshot", runs: [run("conv-2", "running")] },
		{ type: "run", run: run("conv-2", "failed") },
	]);
	expect(changes).toBe(2);
	expect(cues.map((cue) => [cue.id, cue.options.key])).toEqual([
		["run-failed", "run:conv-2"],
	]);
});

test("snapshots and runs that were not running stay silent", async () => {
	const { changes, cues } = await recordCues([
		{ type: "snapshot", runs: [run("conv-3", "completed")] },
		{ type: "run", run: run("conv-3", "completed") },
		{ type: "run", run: run("conv-4", "completed") },
	]);
	expect(changes).toBe(3);
	expect(cues).toEqual([]);
});

test("the foreground chat and the run feed share one cue for the same run", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
	const contexts: FakeAudioContext[] = [];
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
	try {
		__resetSoundEngineForTests();
		// The open chat settles first and plays the motif...
		playSound("run-complete", { key: "run:conv-5" });
		const afterChat = contexts.flatMap((ctx) => ctx.oscillators).length;
		expect(afterChat).toBeGreaterThan(0);
		// Past the per-cue cooldown, so only the shared key can silence it.
		await Bun.sleep(400);
		// ...then the run feed reports the same conversation finishing.
		const changes = await streamFrames([
			{ type: "snapshot", runs: [run("conv-5", "running")] },
			{ type: "run", run: run("conv-5", "completed") },
		]);
		expect(changes).toBe(2);
		expect(contexts.flatMap((ctx) => ctx.oscillators)).toHaveLength(afterChat);
	} finally {
		__resetSoundEngineForTests();
		if (original) {
			Object.defineProperty(globalThis, "AudioContext", original);
		} else {
			Reflect.deleteProperty(globalThis, "AudioContext");
		}
	}
});

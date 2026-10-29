/* @jsxImportSource @opentui/react */
// Shell attention signals: the OSC 2 terminal title follows the focused chat
// (spinner while streaming, plain when idle, cleared on quit), and a turn that
// fails leaves the Herdr pane blocked until the user engages again.
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Writable } from "node:stream";
import { CliRenderer, TextareaRenderable } from "@opentui/core";
import { act } from "react";
import * as herdr from "../core/herdr.ts";
import { testRender } from "./cli-test-render.ts";

let reports: string[][] = [];
const newReporter = () =>
	new herdr.HerdrReporter("pane", async (argv) => {
		reports.push(argv);
	});
// Quitting releases (and stops) the reporter, so each test gets a fresh one
// behind a stable module export.
let reporter = newReporter();
const reporterFacade: Pick<
	herdr.HerdrReporter,
	"release" | "remove" | "reportMetadata" | "update"
> = {
	release: () => reporter.release(),
	remove: (id) => reporter.remove(id),
	reportMetadata: (metadata) => reporter.reportMetadata(metadata),
	update: (id, chat, node) => reporter.update(id, chat, node),
};
mock.module("../core/herdr.ts", () => ({
	...herdr,
	herdrReporter: reporterFacade,
}));
const { App } = await import("../App.tsx");

const realFetch = globalThis.fetch;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
	reports = [];
	reporter = newReporter();
	setup?.renderer.destroy();
	setup = null;
	globalThis.fetch = realFetch;
});

type StreamReply = (controller: ReadableStreamDefaultController) => void;

function installChatFetch(replies: StreamReply[]) {
	const fakeFetch = (
		...args: Parameters<typeof fetch>
	): ReturnType<typeof fetch> => {
		const [input] = args;
		const url = input instanceof Request ? input.url : String(input);
		const reply = url.endsWith("/api/chat/stream") ? replies.shift() : null;
		if (reply) {
			return Promise.resolve(
				new Response(new ReadableStream({ start: reply }), {
					headers: { "Content-Type": "text/event-stream" },
				})
			);
		}
		return Promise.resolve(new Response("Unavailable", { status: 404 }));
	};
	globalThis.fetch = Object.assign(fakeFetch, {
		preconnect: realFetch.preconnect,
	});
}

const encoder = new TextEncoder();
const frame = (data: unknown) =>
	encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

async function settle(rounds = 20) {
	for (let index = 0; index < rounds; index++) {
		await setup?.renderOnce();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function submit(text: string) {
	const input = setup?.renderer.currentFocusedRenderable;
	if (!(input instanceof TextareaRenderable)) {
		throw new Error("Chat composer was not focused");
	}
	act(() => {
		input.insertText(text);
		setup?.mockInput.pressEnter();
	});
	await settle();
}

function lastAgentState(): { message?: string; state?: string } {
	const argv = reports.filter((row) => row[1] === "report-agent").at(-1) ?? [];
	const messageIndex = argv.indexOf("--message");
	return {
		state: argv[argv.indexOf("--state") + 1],
		message: messageIndex >= 0 ? argv[messageIndex + 1] : undefined,
	};
}

test("terminal title spins while the focused chat streams and clears on quit", async () => {
	const titles = spyOn(
		CliRenderer.prototype,
		"setTerminalTitle"
	).mockImplementation(() => undefined);
	let finish: (() => void) | undefined;
	installChatFetch([
		(controller) => {
			finish = () => {
				controller.enqueue(frame({ type: "finish" }));
				controller.close();
			};
		},
	]);
	try {
		setup = await testRender(
			<App target={{ url: "http://127.0.0.1:19000", token: null }} />,
			// As in src/index.tsx: the shell, not the renderer, owns Ctrl+C.
			{ exitOnCtrlC: false, height: 34, width: 120 }
		);
		await settle(2);
		expect(titles.mock.calls.at(-1)).toEqual(["ryu: New chat"]);

		await submit("Hold the stream open");
		expect(titles.mock.calls.at(-1)).toEqual(["⠋ ryu: New chat"]);
		const writesWhileStreaming = titles.mock.calls.length;
		await settle(5);
		// Re-renders during the turn never rewrite an unchanged title.
		expect(titles.mock.calls.length).toBe(writesWhileStreaming);

		finish?.();
		await settle();
		expect(titles.mock.calls.at(-1)).toEqual(["ryu: New chat"]);

		// Ctrl+C quits on its second press (the first arms the exit).
		act(() => setup?.mockInput.pressKey("c", { ctrl: true }));
		await settle();
		expect(titles.mock.calls.at(-1)).toEqual(["ryu: New chat"]);
		act(() => setup?.mockInput.pressKey("c", { ctrl: true }));
		await settle(2);
		expect(titles.mock.calls.at(-1)).toEqual([""]);
	} finally {
		titles.mockRestore();
	}
});

/** A TTY-shaped stdout that keeps every byte the renderer writes. */
function recordingStdout(columns: number, rows: number) {
	const chunks: string[] = [];
	const stream = Object.assign(
		new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(Buffer.from(chunk).toString("utf8"));
				callback();
			},
		}),
		{ columns, getColorDepth: () => 24, isTTY: true, rows }
	);
	return { output: () => chunks.join(""), stream };
}

// Window-title control sequences (OSC 0 sets icon name and window title, OSC 2
// the window title alone), terminated by BEL or ST.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
function titleSequences(output: string): string[] {
	const titles: string[] = [];
	let start = output.indexOf(`${ESC}]`);
	while (start >= 0) {
		const body = start + 4;
		const kind = output.slice(start + 2, body);
		if (kind === "0;" || kind === "2;") {
			const ends = [output.indexOf(BEL, body), output.indexOf(ESC, body)];
			titles.push(
				output.slice(body, Math.min(...ends.filter((at) => at >= 0)))
			);
		}
		start = output.indexOf(`${ESC}]`, start + 2);
	}
	return titles;
}

test("a title change writes the window-title control sequence to the terminal", async () => {
	let finish: (() => void) | undefined;
	installChatFetch([
		(controller) => {
			finish = () => {
				controller.enqueue(frame({ type: "finish" }));
				controller.close();
			};
		},
	]);
	const terminal = recordingStdout(120, 34);
	setup = await testRender(
		<App target={{ url: "http://127.0.0.1:19000", token: null }} />,
		{
			width: 120,
			height: 34,
			// Stream real output bytes to the recording stdout.
			bufferedOutput: "stdout",
			stdout: terminal.stream as unknown as NodeJS.WriteStream,
		}
	);
	await settle(2);
	expect(titleSequences(terminal.output())).toEqual(["ryu: New chat"]);

	await submit("Hold the stream open");
	expect(titleSequences(terminal.output()).at(-1)).toBe("⠋ ryu: New chat");
	finish?.();
	await settle();
	expect(titleSequences(terminal.output())).toEqual([
		"ryu: New chat",
		"⠋ ryu: New chat",
		"ryu: New chat",
	]);
});

test("a failed turn leaves the pane blocked until the user types or submits again", async () => {
	const titles = spyOn(
		CliRenderer.prototype,
		"setTerminalTitle"
	).mockImplementation(() => undefined);
	const failingTurn: StreamReply = (controller) => {
		controller.enqueue(frame({ type: "error", errorText: "HTTP 500" }));
		controller.enqueue(frame({ type: "finish" }));
		controller.close();
	};
	installChatFetch([
		failingTurn,
		failingTurn,
		(controller) => {
			controller.enqueue(frame({ type: "finish" }));
			controller.close();
		},
	]);
	try {
		setup = await testRender(
			<App target={{ url: "http://127.0.0.1:19000", token: null }} />,
			{ width: 120, height: 34 }
		);
		await settle(2);
		await submit("This turn fails");
		expect(lastAgentState()).toEqual({
			state: "blocked",
			message: "Error: HTTP 500",
		});

		// Typing in the composer is engagement: attention clears.
		const input = setup.renderer.currentFocusedRenderable;
		if (!(input instanceof TextareaRenderable)) {
			throw new Error("Chat composer was not focused");
		}
		act(() => input.insertText("R"));
		await settle(4);
		expect(lastAgentState()).toEqual({ state: "idle", message: undefined });
		act(() => setup?.mockInput.pressEnter());
		await settle();
		expect(lastAgentState()).toEqual({
			state: "blocked",
			message: "Error: HTTP 500",
		});

		await submit("Try again");
		expect(lastAgentState()).toEqual({ state: "idle", message: undefined });
	} finally {
		titles.mockRestore();
	}
});

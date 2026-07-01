/**
 * `ryu dev <entry>` — local dev playground for Ryu Runnables.
 *
 * Loads a developer-authored Runnable module from `<entry>`, starts an
 * interactive chat/run loop in the terminal, and routes every model call
 * through the local gateway (via the ModelClient from unit-c). The loop
 * mirrors AcpEvent categories — text, tool-call, tool-result, error — so
 * what a developer sees locally matches what Core will surface once the
 * app is wrapped as an engine.
 *
 * Gateway URL resolution (same order as ModelClient):
 *   1. RYU_GATEWAY_URL env var
 *   2. http://127.0.0.1:7981 (Core default)
 *
 * If the gateway is unreachable the command prints a clear error and exits
 * non-zero.  No silent provider fallback is ever attempted.
 *
 * Usage:
 *   bunx ryu dev <entry>
 *   bunx ryu dev ./my-agent.ts
 *   RYU_GATEWAY_URL=http://my-gateway:7981 bunx ryu dev ./my-agent.ts
 */

import { createInterface } from "node:readline";
import type { ChatMessage } from "../model/client.ts";
import { ModelClient } from "../model/client.ts";
import { resolveGatewayUrl } from "../model/gateway.ts";

// Top-level regex for absolute Windows/Unix path detection.
const RE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

// ── Dev event types (mirrors AcpEvent in acp.rs) ─────────────────────────────

/** A streamed text chunk from the assistant. */
export interface DevEventText {
	content: string;
	type: "text";
}

/** A tool call the Runnable has initiated (mirrors AcpEvent::ToolCall). */
export interface DevEventToolCall {
	id: string;
	input: unknown;
	kind: string;
	title: string;
	type: "tool_call";
}

/** A tool result/update (mirrors AcpEvent::ToolResult). */
export interface DevEventToolResult {
	id: string;
	output: unknown;
	status: "completed" | "failed" | "in_progress" | "pending";
	type: "tool_result";
}

/** A fatal error event — stream ends after this. */
export interface DevEventError {
	message: string;
	type: "error";
}

/** Union of all playground event types. */
export type DevEvent =
	| DevEventError
	| DevEventText
	| DevEventToolCall
	| DevEventToolResult;

// ── Runnable contract ─────────────────────────────────────────────────────────

/**
 * The Runnable interface a developer's module must export as `default` or
 * named `runnable`. This is the input→run→output contract from the object
 * model.
 *
 * The `run` generator yields `DevEvent` objects so the playground can stream
 * assistant text, tool calls, and results to the terminal in real time.
 */
export interface Runnable {
	/** Human-readable name shown in the playground header. */
	name: string;
	/**
	 * Execute one turn. Receives the conversation history and a ModelClient
	 * already pointed at the gateway. Yields `DevEvent` objects as the turn
	 * progresses.
	 */
	run(
		messages: ChatMessage[],
		model: ModelClient
	): AsyncGenerator<DevEvent> | Generator<DevEvent>;
}

// ── Gateway reachability check ────────────────────────────────────────────────

/**
 * Probe the gateway at `baseUrl` with a HEAD request.
 *
 * Returns `true` when any HTTP response is received (even 4xx — the gateway
 * is reachable), `false` when the request fails with a network error.
 */
export async function probeGateway(baseUrl: string): Promise<boolean> {
	try {
		await fetch(`${baseUrl}/health`, {
			method: "HEAD",
			signal: AbortSignal.timeout(3000),
		});
		return true;
	} catch {
		return false;
	}
}

// ── Module loader ─────────────────────────────────────────────────────────────

/**
 * Dynamically import a Runnable from `entryPath`.
 *
 * The module must export either:
 *   - `default` — the Runnable object
 *   - `runnable` — the Runnable object
 *
 * Throws when neither export is found or when the loaded value does not look
 * like a Runnable (i.e. has no `run` function).
 */
export async function loadRunnable(entryPath: string): Promise<Runnable> {
	// Resolve to an absolute path so dynamic import works regardless of cwd.
	const abs =
		entryPath.startsWith("/") || RE_ABSOLUTE_PATH.test(entryPath)
			? entryPath
			: `${process.cwd()}/${entryPath}`;

	const mod = (await import(abs)) as Record<string, unknown>;

	const candidate: unknown = mod.default ?? mod.runnable;

	if (
		!candidate ||
		typeof (candidate as Record<string, unknown>).run !== "function"
	) {
		throw new Error(
			`[ryu dev] Module at "${entryPath}" must export a Runnable as "default" or "runnable". ` +
				'A Runnable has a "run(messages, model)" generator method.'
		);
	}

	return candidate as Runnable;
}

// ── Turn renderer ─────────────────────────────────────────────────────────────

/** ANSI escape sequences for terminal colours. */
const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	cyan: "\x1b[36m",
	yellow: "\x1b[33m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	dim: "\x1b[2m",
} as const;

function printBanner(runnableName: string, gatewayUrl: string): void {
	process.stdout.write(
		[
			"",
			`${ANSI.bold}${ANSI.cyan}ryu dev${ANSI.reset} — local Runnable playground`,
			`${ANSI.dim}runnable : ${runnableName}${ANSI.reset}`,
			`${ANSI.dim}gateway  : ${gatewayUrl}${ANSI.reset}`,
			`${ANSI.dim}type "/quit" or Ctrl+C to exit${ANSI.reset}`,
			"",
		].join("\n")
	);
}

function printPrompt(): void {
	process.stdout.write(`${ANSI.bold}> ${ANSI.reset}`);
}

function printAssistantStart(): void {
	process.stdout.write(`\n${ANSI.green}assistant:${ANSI.reset} `);
}

function printAssistantEnd(): void {
	process.stdout.write("\n");
}

function printToolCall(event: DevEventToolCall): void {
	process.stdout.write(
		`\n${ANSI.yellow}tool-call${ANSI.reset} [${event.id}] ${event.title} (${event.kind})`
	);
	if (event.input !== null && event.input !== undefined) {
		process.stdout.write(
			` ${ANSI.dim}${JSON.stringify(event.input)}${ANSI.reset}`
		);
	}
	process.stdout.write("\n");
}

function statusAnsiColor(status: DevEventToolResult["status"]): string {
	if (status === "completed") {
		return ANSI.green;
	}
	if (status === "failed") {
		return ANSI.red;
	}
	return ANSI.dim;
}

function printToolResult(event: DevEventToolResult): void {
	const statusColor = statusAnsiColor(event.status);
	process.stdout.write(
		`${ANSI.dim}tool-result${ANSI.reset} [${event.id}] ${statusColor}${event.status}${ANSI.reset}`
	);
	if (event.output !== null && event.output !== undefined) {
		process.stdout.write(
			` ${ANSI.dim}${JSON.stringify(event.output)}${ANSI.reset}`
		);
	}
	process.stdout.write("\n");
}

function printError(message: string): void {
	process.stderr.write(`\n${ANSI.red}error:${ANSI.reset} ${message}\n`);
}

// ── Turn runner ───────────────────────────────────────────────────────────────

/**
 * Run one turn against the Runnable and stream events to the terminal.
 *
 * Returns `false` when a fatal DevEventError is encountered (caller should
 * offer the user a chance to retry), `true` on clean completion.
 */
export async function runTurn(
	runnable: Runnable,
	messages: ChatMessage[],
	model: ModelClient
): Promise<boolean> {
	printAssistantStart();

	const gen = runnable.run(messages, model);

	let hasError = false;

	for await (const event of gen) {
		switch (event.type) {
			case "text": {
				process.stdout.write(event.content);
				break;
			}
			case "tool_call": {
				printToolCall(event);
				break;
			}
			case "tool_result": {
				printToolResult(event);
				break;
			}
			case "error": {
				printAssistantEnd();
				printError(event.message);
				hasError = true;
				break;
			}
			default:
				break;
		}
	}

	if (!hasError) {
		printAssistantEnd();
	}

	return !hasError;
}

// ── Interactive loop ──────────────────────────────────────────────────────────

/**
 * Run the interactive dev playground loop.
 *
 * Reads lines from stdin, passes each to `runnable.run`, streams events to
 * stdout, and maintains conversation history across turns.
 *
 * Exits cleanly on Ctrl+C, EOF, or the `/quit` command.
 */
export async function runDevLoop(
	runnable: Runnable,
	model: ModelClient
): Promise<void> {
	const history: ChatMessage[] = [];

	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	const linePromise = (): Promise<string | null> =>
		new Promise((resolve) => {
			rl.once("line", resolve);
			rl.once("close", () => resolve(null));
		});

	printPrompt();

	while (true) {
		const line = await linePromise();

		if (line === null) {
			// EOF / Ctrl+C
			process.stdout.write("\n");
			break;
		}

		const trimmed = line.trim();

		if (trimmed === "") {
			printPrompt();
			continue;
		}

		if (trimmed === "/quit" || trimmed === "/exit") {
			process.stdout.write("bye\n");
			break;
		}

		history.push({ role: "user", content: trimmed });

		let assistantReply = "";
		printAssistantStart();

		const gen = runnable.run([...history], model);

		for await (const event of gen) {
			switch (event.type) {
				case "text": {
					process.stdout.write(event.content);
					assistantReply += event.content;
					break;
				}
				case "tool_call": {
					printToolCall(event);
					break;
				}
				case "tool_result": {
					printToolResult(event);
					break;
				}
				case "error": {
					printAssistantEnd();
					printError(event.message);
					// Remove the user message from history on error.
					history.pop();
					assistantReply = "";
					break;
				}
				default:
					break;
			}
		}

		printAssistantEnd();

		if (assistantReply) {
			history.push({ role: "assistant", content: assistantReply });
		}

		printPrompt();
	}

	rl.close();
}

// ── commandDev ────────────────────────────────────────────────────────────────

/**
 * Entry point for the `ryu dev <entry>` command.
 *
 * 1. Resolves and validates the gateway URL.
 * 2. Probes gateway reachability — hard-exits on failure (no silent fallback).
 * 3. Loads the Runnable module from `entryPath`.
 * 4. Prints the banner and starts the interactive loop.
 */
export async function commandDev(entryPath: string): Promise<void> {
	const gatewayUrl = resolveGatewayUrl();

	// Probe gateway — fail-closed: no fallback.
	process.stdout.write(`checking gateway at ${gatewayUrl} ...\n`);
	const reachable = await probeGateway(gatewayUrl);
	if (!reachable) {
		process.stderr.write(
			[
				"",
				`${ANSI.red}error:${ANSI.reset} gateway not reachable at ${gatewayUrl}`,
				"",
				"The ryu dev playground requires a running Ryu gateway.",
				"Start the gateway with: ryu gateway start",
				"Or set RYU_GATEWAY_URL to point at a remote gateway.",
				"",
				"No provider fallback is attempted. Fix the gateway connection and retry.",
				"",
			].join("\n")
		);
		process.exit(1);
	}

	// Load the Runnable module.
	let runnable: Runnable;
	try {
		runnable = await loadRunnable(entryPath);
	} catch (err) {
		process.stderr.write(`error: ${String(err)}\n`);
		process.exit(1);
	}

	// Build the gateway-mandatory model client (default model — configurable via
	// the Runnable's own defineModel calls, but the client the loop passes is
	// the default one so the playground itself can do health checks).
	const model = new ModelClient("default", { baseUrl: gatewayUrl });

	printBanner(runnable.name, gatewayUrl);
	await runDevLoop(runnable, model);
}

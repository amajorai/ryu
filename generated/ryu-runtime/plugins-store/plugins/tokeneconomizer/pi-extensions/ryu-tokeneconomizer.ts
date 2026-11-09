/**
 * Ryu TokenEconomizer: runs the user's own TokenEconomizer install inside the
 * flagship, managed "ryu" (Pi) agent.
 *
 * Adapted from `plugin/pi/tokeneconomizer.ts` in microsoft/TokenEconomizer
 * (https://github.com/microsoft/TokenEconomizer, commit cb42207), Copyright (c)
 * Microsoft Corporation, licensed under the Apache License, Version 2.0. Changes:
 * the TokenEconomizer folder is read from the pointer file Ryu Core writes
 * instead of being found next to this file, the plugin's own model calls are
 * pointed at Ryu's managed Pi, the `/te` command is dropped, and sub-agents are
 * skipped.
 *
 * WHAT IT DOES
 * ------------
 * TokenEconomizer learns from earlier sessions in a repository and uses that
 * to cut what later sessions pay for. Its logic lives in its own Python
 * dispatcher (`<plugin>/scripts/te-hook --host pi`, JSON in, JSON out). This
 * file only translates Pi events into dispatcher calls and applies the answer:
 *
 *   session_start       -> SessionStart       the learned facts, kept for the session
 *   before_agent_start  -> UserPromptSubmit   opens a prompt turn; the facts are set as the
 *                                             `tokeneconomizer` system-prompt section on
 *                                             every prompt (Pi diffs sections between runs,
 *                                             so an omitted one would be recorded as removed)
 *   tool_result         -> PostToolUse        the loop guard; a redirect is delivered as a
 *                                             steering message
 *   agent_end           -> Stop               closes the turn
 *   session_shutdown    -> SessionEnd         hands the session to a background fold
 *
 * BRING YOUR OWN, FAIL OPEN
 * -------------------------
 * Ryu ships none of TokenEconomizer. The user clones it and names the folder in
 * the plugin's settings; Core validates the folder and writes
 * `$PI_CODING_AGENT_DIR/tokeneconomizer.json`. With no pointer file, no
 * dispatcher, or a dispatcher that is slow or broken, every event answers "no
 * change" and the agent carries on as if this extension were not loaded. Only
 * the managed agent dir gets a pointer: limited agents' config dirs never do,
 * so the extension stays inert for them.
 *
 * NEVER REGISTER A SLASH COMMAND
 * ------------------------------
 * `pi.registerCommand` is fatal over ACP (see `ryu-monitor.ts`): a registered
 * command short-circuits `AgentSession.prompt` and the ACP request never
 * returns. The upstream `/te` command is therefore not ported; `te` runs from
 * a terminal instead.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** The pointer file Core writes into the managed Pi config dir. */
export const POINTER_FILE = "tokeneconomizer.json";
/** Developer override for the TokenEconomizer plugin folder. */
export const PLUGIN_DIR_ENV = "RYU_TOKENECONOMIZER_PLUGIN_DIR";
/** Set in every Pi process `pi-subagent` spawns. */
const SUBAGENT_MARKER = "RYU_PI_SUBAGENT";
/** The system-prompt section name, the same as upstream so state carries over. */
export const SECTION = "tokeneconomizer";
const HOOK_TIMEOUT_MS = 60_000;

const MICROSKILLS_MODES = new Set(["on", "off", "envfacts"]);
const LOOPGUARD_MODES = new Set(["on", "off"]);

export interface TokenEconomizerConfig {
	loopguard?: string;
	microskills?: string;
	/** Absolute path of the Pi CLI the plugin's own model calls run. */
	piCli?: string;
	/** Absolute path of TokenEconomizer's `plugin/` folder. */
	pluginDir: string;
}

type Env = Record<string, string | undefined>;

const truthy = (value: string | undefined) =>
	["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

/** The dispatcher a plugin folder ships, or `null` when it is not there. */
function hasDispatcher(pluginDir: string, platform: string): boolean {
	const script =
		platform === "win32"
			? path.join(pluginDir, "scripts", "te_bootstrap.py")
			: path.join(pluginDir, "scripts", "te-hook");
	return existsSync(script);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Read the TokenEconomizer config for this Pi process, or `null` when the
 * extension should stay inert. Never throws.
 */
export function resolveConfig(
	env: Env = process.env,
	platform: string = process.platform
): TokenEconomizerConfig | null {
	if (truthy(env.TE_SIDECALL) || truthy(env.TE_DISABLE)) {
		return null;
	}
	if (env[SUBAGENT_MARKER] === "1") {
		return null;
	}
	let pointer: Record<string, unknown> = {};
	const agentDir = env.PI_CODING_AGENT_DIR?.trim();
	if (agentDir) {
		try {
			const parsed: unknown = JSON.parse(
				readFileSync(path.join(agentDir, POINTER_FILE), "utf8")
			);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				pointer = parsed as Record<string, unknown>;
			}
		} catch {
			// No pointer (the usual case before setup) or an unreadable one.
		}
	}
	const pluginDir =
		optionalString(env[PLUGIN_DIR_ENV]) ?? optionalString(pointer.pluginDir);
	if (!(pluginDir && path.isAbsolute(pluginDir))) {
		return null;
	}
	if (!hasDispatcher(pluginDir, platform)) {
		return null;
	}
	const config: TokenEconomizerConfig = { pluginDir };
	const piCli = optionalString(pointer.piCli);
	if (piCli && path.isAbsolute(piCli)) {
		config.piCli = piCli;
	}
	const microskills = optionalString(pointer.microskills);
	if (microskills && MICROSKILLS_MODES.has(microskills)) {
		config.microskills = microskills;
	}
	const loopguard = optionalString(pointer.loopguard);
	if (loopguard && LOOPGUARD_MODES.has(loopguard)) {
		config.loopguard = loopguard;
	}
	return config;
}

/**
 * The environment additions a dispatcher call runs with. The Pi process's own
 * environment (including `PI_CODING_AGENT_DIR`) is inherited, so the plugin's
 * model calls use the same config, routing and sign-ins as the agent.
 */
export function hookEnv(
	config: TokenEconomizerConfig,
	mode: string
): Record<string, string> {
	const extra: Record<string, string> = {
		PYTHONUTF8: "1",
		TE_PI_MODE: mode,
	};
	if (config.piCli) {
		extra.TE_PI_CLI = config.piCli;
	}
	if (config.microskills) {
		extra.TE_MICROSKILLS = config.microskills;
	}
	if (config.loopguard) {
		extra.TE_LOOPGUARD = config.loopguard;
	}
	return extra;
}

/**
 * The program and arguments that run the dispatcher. The launcher is POSIX
 * `sh`, which Windows cannot start; there its bootstrap runs under Python
 * (`TE_PYTHON`, else `python`).
 */
export function launch(
	pluginDir: string,
	platform: string = process.platform,
	env: Env = process.env
): [string, string[]] {
	const scripts = path.join(pluginDir, "scripts");
	if (platform !== "win32") {
		return [path.join(scripts, "te-hook"), ["--host", "pi"]];
	}
	return [
		env.TE_PYTHON || "python",
		[path.join(scripts, "te_bootstrap.py"), "hook", "--host", "pi"],
	];
}

/** Run the dispatcher with `input` on stdin; resolve to its stdout, or "". */
function runDispatcher(
	config: TokenEconomizerConfig,
	input: string,
	mode: string
): Promise<string> {
	return new Promise((resolve) => {
		let out = "";
		let child: ReturnType<typeof spawn>;
		try {
			const [program, argv] = launch(config.pluginDir);
			child = spawn(program, argv, {
				env: { ...process.env, ...hookEnv(config, mode) },
				stdio: ["pipe", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve("");
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve("");
		}, HOOK_TIMEOUT_MS);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve("");
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(out);
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(input);
	});
}

/** The dispatcher's answer: the last stdout line as JSON, `{}` otherwise. */
export function parseAnswer(stdout: string): Record<string, unknown> {
	const last = stdout.trim().split("\n").pop() ?? "";
	try {
		const parsed: unknown = JSON.parse(last || "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function additionalContext(answer: Record<string, unknown>): string {
	const specific = answer.hookSpecificOutput;
	if (specific && typeof specific === "object") {
		const text = (specific as Record<string, unknown>).additionalContext;
		return typeof text === "string" ? text : "";
	}
	return "";
}

/** A notice in the UI; on stderr when Pi has no UI (print, json, rpc). */
function notify(ctx: ExtensionContext, text: unknown) {
	if (typeof text !== "string" || !text) {
		return;
	}
	if (ctx.hasUI) {
		ctx.ui.notify(text, "info");
	} else {
		process.stderr.write(`${text}\n`);
	}
}

const SOURCE: Record<string, string> = {
	startup: "startup",
	new: "clear",
	resume: "resume",
	fork: "resume",
	reload: "resume",
};

interface BranchEntry {
	message?: { role?: string; sections?: Record<string, string> };
	systemMessage?: { sections?: Record<string, string> };
	type?: string;
}

/**
 * The section a conversation that already holds messages carries. Pi replays
 * its system entries into every request, so a resumed conversation must be
 * given the same text again: leaving it out records it as removed, and new
 * text would re-read the whole conversation at the uncached price.
 */
export function carriedSection(entries: readonly BranchEntry[]): string {
	let text = "";
	for (const entry of entries) {
		if (entry?.type === "compaction" && entry.systemMessage?.sections) {
			text = entry.systemMessage.sections[SECTION] ?? "";
		} else if (
			entry?.type === "message" &&
			entry.message?.role === "system" &&
			entry.message.sections &&
			SECTION in entry.message.sections
		) {
			text = entry.message.sections[SECTION] ?? "";
		}
	}
	const open = `<${SECTION}>\n`;
	const close = `\n</${SECTION}>`;
	return text.startsWith(open) && text.endsWith(close)
		? text.slice(open.length, text.length - close.length)
		: text;
}

export default function ryuTokenEconomizer(pi: ExtensionAPI) {
	const config = resolveConfig();
	if (!config) {
		return;
	}
	let manual = "";
	let prompts = 0;
	let turn = "";

	const base = (ctx: ExtensionContext) => ({
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: ctx.sessionManager.getSessionFile() ?? "",
		cwd: ctx.cwd,
	});
	const hook = async (payload: Record<string, unknown>, mode: string) =>
		parseAnswer(await runDispatcher(config, JSON.stringify(payload), mode));

	pi.on("session_start", async (event, ctx) => {
		prompts = 0;
		const entries = (ctx.sessionManager.getBranch?.() ??
			[]) as unknown as BranchEntry[];
		const carried = entries.some((entry) => entry?.type === "message");
		const source = carried ? "resume" : (SOURCE[event.reason] ?? "startup");
		const answer = await hook(
			{ ...base(ctx), hook_event_name: "SessionStart", source },
			ctx.mode
		);
		manual = carried ? carriedSection(entries) : additionalContext(answer);
		notify(ctx, answer.systemMessage);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		prompts += 1;
		turn = `${ctx.sessionManager.getSessionId()}:${prompts}`;
		const answer = await hook(
			{
				...base(ctx),
				hook_event_name: "UserPromptSubmit",
				prompt_id: turn,
				prompt: event.prompt,
			},
			ctx.mode
		);
		const extra = additionalContext(answer);
		if (extra) {
			manual = manual ? `${manual}\n\n${extra}` : extra;
		}
		notify(ctx, answer.systemMessage);
		if (manual) {
			event.systemPromptOptions.sections = {
				...(event.systemPromptOptions.sections ?? {}),
				[SECTION]: manual,
			};
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const content = (event.content ?? [])
			.filter((part) => part?.type === "text")
			.map((part) => ("text" in part ? part.text : ""))
			.join("\n");
		const structured = (event.structuredContent ?? {}) as Record<
			string,
			unknown
		>;
		const answer = await hook(
			{
				...base(ctx),
				hook_event_name: "PostToolUse",
				prompt_id: turn,
				tool_name: event.toolName,
				tool_use_id: event.toolCallId,
				tool_input: event.input ?? {},
				tool_response: {
					content,
					isError: event.isError,
					exit_code: structured.exit_code,
				},
			},
			ctx.mode
		);
		const nudge = additionalContext(answer);
		if (nudge) {
			pi.sendMessage(
				{ customType: SECTION, content: nudge, display: true },
				{ deliverAs: "steer" }
			);
		}
		notify(ctx, answer.systemMessage);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await hook(
			{
				...base(ctx),
				hook_event_name: "Stop",
				prompt_id: turn,
				stop_hook_active: false,
			},
			ctx.mode
		);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		await hook(
			{ ...base(ctx), hook_event_name: "SessionEnd", reason: event.reason },
			ctx.mode
		);
	});
}

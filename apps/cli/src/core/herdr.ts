import { z } from "zod";
import type { ChatStreamOptions } from "./chatStream.ts";

function invalidResumeArgument(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return character === "'" || code < 32 || (code >= 127 && code <= 159);
	});
}

function baseResumeArguments(node: string | undefined): string[] {
	if (!node || invalidResumeArgument(node) || Buffer.byteLength(node) > 8000) {
		return ["ryu-cli", "tui"];
	}
	try {
		const url = new URL(node);
		if (url.username || url.password || url.search || url.hash) {
			return ["ryu-cli", "tui"];
		}
	} catch {
		return ["ryu-cli", "tui"];
	}
	return ["ryu-cli", "tui", "--node", node];
}

export type HerdrState = "idle" | "working" | "blocked";

/** Longest Herdr attention message (and metadata field) Ryu puts in argv. */
export const HERDR_TEXT_LIMIT = 80;

function isControlCharacter(character: string): boolean {
	const code = character.charCodeAt(0);
	return code < 32 || (code >= 127 && code <= 159);
}

/**
 * One display line safe for Herdr argv: the first non-empty line, control
 * characters dropped, whitespace collapsed, capped with an ellipsis.
 */
export function herdrText(value: string, limit = HERDR_TEXT_LIMIT): string {
	const line =
		value
			.split(/\r\n|\r|\n/)
			.map((part) => part.trim())
			.find((part) => part.length > 0) ?? "";
	const clean = [...line]
		.filter((character) => !isControlCharacter(character))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...clean];
	return characters.length > limit
		? `${characters.slice(0, limit - 1).join("")}…`
		: clean;
}

/** The blocked-on-error attention message for a failed chat turn. */
export function herdrErrorMessage(message: string): string {
	const detail = herdrText(message, HERDR_TEXT_LIMIT - "Error: ".length);
	return detail ? `Error: ${detail}` : "Error";
}

/** Display-only pane metadata: the conversation title and its model. */
export interface HerdrMetadata {
	model?: string | null;
	title: string;
}

export interface HerdrChat {
	focused: boolean;
	message?: string;
	options?: ChatStreamOptions;
	state: HerdrState;
}

export function resumeArguments(
	options: ChatStreamOptions,
	node: string
): string[] | null {
	if (!options.conversationId) {
		return null;
	}
	const base = baseResumeArguments(node);
	if (base.length === 2) {
		return null;
	}
	const argv = [
		...base,
		"--resume",
		options.conversationId,
		"--resume-options",
		JSON.stringify({
			agentId: options.agentId,
			teamId: options.teamId,
			acpModel: options.acpModel,
			acpMode: options.acpMode,
			acpConfig: options.acpConfig,
			pluginFlags: options.pluginFlags,
		}),
	];
	if (
		argv.some(invalidResumeArgument) ||
		Buffer.byteLength(argv.join(" ")) > 8192
	) {
		return null;
	}
	return argv;
}

const resumeStringSelectionsSchema = z
	.record(z.string(), z.string().nullable().catch(null))
	.transform((value) =>
		Object.fromEntries(
			Object.entries(value).filter(([, field]) => field !== null)
		)
	)
	.pipe(z.record(z.string(), z.string()));
const resumePluginFlagsSchema = z
	.record(z.string(), z.boolean().nullable().catch(null))
	.transform((value) =>
		Object.fromEntries(
			Object.entries(value).filter(([, field]) => field !== null)
		)
	)
	.pipe(z.record(z.string(), z.boolean()));
const resumeOptionsSchema = z.object({
	agentId: z.string().optional().catch(undefined),
	teamId: z.string().optional().catch(undefined),
	acpModel: z.string().optional().catch(undefined),
	acpMode: z.string().optional().catch(undefined),
	acpConfig: resumeStringSelectionsSchema.optional().catch(undefined),
	pluginFlags: resumePluginFlagsSchema.optional().catch(undefined),
});

/** Parse only the routing fields we author. Credentials never enter resume argv. */
export function parseResumeOptions(
	value: string | undefined
): ChatStreamOptions {
	if (!value || value.length > 8192) {
		return {};
	}
	try {
		const parsed = resumeOptionsSchema.safeParse(JSON.parse(value));
		if (!parsed.success) {
			return {};
		}
		const options: ChatStreamOptions = {};
		for (const key of ["agentId", "teamId", "acpModel", "acpMode"] as const) {
			const field = parsed.data[key];
			if (field !== undefined) {
				options[key] = field;
			}
		}
		if (parsed.data.acpConfig !== undefined) {
			options.acpConfig = parsed.data.acpConfig;
		}
		if (parsed.data.pluginFlags !== undefined) {
			options.pluginFlags = parsed.data.pluginFlags;
		}
		return options;
	} catch {
		return {};
	}
}

export type HerdrSend = (argv: string[]) => Promise<void>;

/**
 * Thrown by a send when Herdr rejected a metadata report, so the reporter stops
 * spawning a subprocess for a verb this Herdr build does not know.
 */
export class HerdrMetadataRejected extends Error {}

/** The exit code Herdr's CLI uses for a command or flag it does not know. */
const HERDR_USAGE_EXIT_CODE = 2;

/** One reporter owns the pane, including when multiple Ryu chat tabs are open. */
export class HerdrReporter {
	private readonly chats = new Map<symbol, HerdrChat & { node: string }>();
	private pending: string[] | null = null;
	private running: Promise<void> | null = null;
	private previous = "";
	private sequence = 0;
	private stopped = false;
	// Metadata has its own latest-wins slot so it never coalesces away a state
	// report (and a state report never drops the latest title).
	private pendingMetadata: string[] | null = null;
	private runningMetadata: Promise<void> | null = null;
	private previousMetadata = "";
	private metadataUnsupported = false;

	constructor(
		private readonly pane: string,
		private readonly send: HerdrSend
	) {}

	private nextSequence(): string {
		this.sequence = Math.max(Date.now() * 1000, this.sequence + 1);
		return String(this.sequence);
	}

	private enqueue(argv: string[]): void {
		this.pending = argv;
		this.running ??= Promise.resolve().then(() => this.drain());
	}

	private async drain(): Promise<void> {
		while (this.pending) {
			const argv = this.pending;
			this.pending = null;
			try {
				await this.send(argv);
			} catch {
				// Herdr is optional. Its failure must not interrupt Ryu.
			}
		}
		this.running = null;
	}

	private async drainMetadata(): Promise<void> {
		while (this.pendingMetadata) {
			const argv = this.pendingMetadata;
			this.pendingMetadata = null;
			try {
				await this.send(argv);
			} catch (error) {
				if (error instanceof HerdrMetadataRejected) {
					// An older Herdr without `pane report-metadata`: stop asking.
					this.metadataUnsupported = true;
					this.pendingMetadata = null;
				}
			}
		}
		this.runningMetadata = null;
	}

	/** Report the pane's display title and model. Latest wins; failures are ignored. */
	reportMetadata(metadata: HerdrMetadata): void {
		if (this.stopped || this.metadataUnsupported) {
			return;
		}
		const title = herdrText(metadata.title);
		if (!title) {
			return;
		}
		const model = metadata.model ? herdrText(metadata.model) : "";
		const argv = [
			"pane",
			"report-metadata",
			this.pane,
			"--source",
			"ryu",
			"--title",
			title,
		];
		if (model) {
			argv.push("--token", `model=${model}`);
		} else {
			argv.push("--clear-token", "model");
		}
		const signature = JSON.stringify(argv);
		if (signature === this.previousMetadata) {
			return;
		}
		this.previousMetadata = signature;
		argv.push("--seq", this.nextSequence());
		this.pendingMetadata = argv;
		this.runningMetadata ??= Promise.resolve().then(() => this.drainMetadata());
	}

	update(id: symbol, chat: HerdrChat, node: string): void {
		if (this.stopped) {
			return;
		}
		this.chats.set(id, { ...chat, node });
		this.report();
	}

	remove(id: symbol): void {
		this.chats.delete(id);
		this.report();
	}

	private report(): void {
		if (this.stopped) {
			return;
		}
		const chats = [...this.chats.values()];
		const selected =
			chats.find((chat) => chat.state === "blocked") ??
			chats.find((chat) => chat.state === "working") ??
			chats.find((chat) => chat.focused) ??
			chats[0];
		const state = selected?.state ?? "idle";
		const resume =
			(selected?.options
				? resumeArguments(selected.options, selected.node)
				: null) ?? baseResumeArguments(selected?.node);
		const argv = [
			"pane",
			"report-agent",
			this.pane,
			"--source",
			"ryu",
			"--agent",
			"ryu",
			"--state",
			state,
		];
		if (selected?.message && state === "blocked") {
			argv.push("--message", selected.message);
		}
		if (resume && selected?.options?.conversationId) {
			argv.push("--agent-session-id", selected.options.conversationId);
		}
		const signature = JSON.stringify([argv, resume]);
		if (signature === this.previous) {
			return;
		}
		this.previous = signature;
		argv.push("--seq", this.nextSequence());
		if (resume) {
			argv.push("--", ...resume);
		}
		this.enqueue(argv);
	}

	async release(): Promise<void> {
		if (!this.stopped) {
			this.stopped = true;
			this.enqueue([
				"pane",
				"release-agent",
				this.pane,
				"--source",
				"ryu",
				"--agent",
				"ryu",
				"--seq",
				this.nextSequence(),
			]);
		}
		// Metadata outlives the reporter in Herdr, so clear Ryu's title and model
		// token; otherwise the shell left in the pane keeps showing the chat.
		this.pendingMetadata =
			this.previousMetadata && !this.metadataUnsupported
				? [
						"pane",
						"report-metadata",
						this.pane,
						"--source",
						"ryu",
						"--clear-title",
						"--clear-token",
						"model",
						"--seq",
						this.nextSequence(),
					]
				: null;
		this.previousMetadata = "";
		if (this.pendingMetadata) {
			this.runningMetadata ??= Promise.resolve().then(() =>
				this.drainMetadata()
			);
		}
		await Promise.all([this.running, this.runningMetadata]);
	}
}

export function createHerdrReporter(
	env: NodeJS.ProcessEnv
): HerdrReporter | null {
	const binary = env.HERDR_BIN_PATH;
	const pane = env.HERDR_PANE_ID;
	if (env.HERDR_ENV !== "1" || !binary || !pane || !env.HERDR_SOCKET_PATH) {
		return null;
	}
	const send = async (argv: string[]): Promise<number> => {
		const child = Bun.spawn([binary, ...argv], {
			env: { ...process.env, ...env },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		});
		const timeout = setTimeout(() => child.kill(), 5000);
		try {
			return await child.exited;
		} finally {
			clearTimeout(timeout);
		}
	};
	return new HerdrReporter(pane, async (argv) => {
		const exitCode = await send(argv);
		if (argv[1] === "report-metadata") {
			// Herdr exits 2 for a usage error (an unknown verb or flag); any other
			// failure (socket down, timeout) is transient and retried next time.
			if (exitCode === HERDR_USAGE_EXIT_CODE) {
				throw new HerdrMetadataRejected(`Herdr exited with ${exitCode}`);
			}
			return;
		}
		const resumeIndex = argv.indexOf("--");
		if (exitCode !== 0 && resumeIndex >= 0) {
			// Older Herdr CLIs can reject resume argv. Still report the state.
			await send(argv.slice(0, resumeIndex));
		}
	});
}

export const herdrReporter = createHerdrReporter(process.env);

let startupConsumed = false;
export interface StartupResume {
	id: string;
	options: ChatStreamOptions;
}
export function takeStartupResume(): StartupResume | null {
	if (startupConsumed) {
		return null;
	}
	startupConsumed = true;
	const argv = process.argv.slice(2);
	const index = argv.indexOf("--resume");
	const id = index >= 0 ? argv[index + 1] : undefined;
	if (!id || id.startsWith("--")) {
		return null;
	}
	const optionsIndex = argv.indexOf("--resume-options");
	return {
		id,
		options: parseResumeOptions(
			optionsIndex >= 0 ? argv[optionsIndex + 1] : undefined
		),
	};
}

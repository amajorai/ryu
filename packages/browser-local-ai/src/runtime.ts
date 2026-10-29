import type {
	ProgressInfo,
	TextGenerationOutput,
	TextGenerationPipeline,
} from "@huggingface/transformers";
import { z } from "zod";

import {
	type BrowserModelStatus,
	createBrowserModelDefinition,
	isValidBrowserModelId,
} from "./catalog.ts";

export interface BrowserGenerationRequest {
	messages: Array<{
		content: string;
		role: "assistant" | "system" | "user";
	}>;
	modelId: string;
	requestId?: string;
	tools?: BrowserToolDefinition[];
}

export interface BrowserGenerationResult {
	text: string;
	toolCalls: BrowserToolCall[];
}

export interface BrowserRuntimeStatus {
	modelId: string;
	progress?: number;
	status: BrowserModelStatus;
	statusMessage?: string;
}

export type BrowserRuntimeListener = (status: BrowserRuntimeStatus) => void;

export interface BrowserLocalRuntimeOptions {
	onStatus?: BrowserRuntimeListener;
	/** Packaged host WASM binary; uses the bundled factory without blob imports. */
	wasmBinaryUrl?: string;
}

const browserToolDefinitionSchema = z.record(z.string(), z.json());
export type BrowserToolDefinition = z.infer<typeof browserToolDefinitionSchema>;
const browserToolDefinitionsSchema = z.array(browserToolDefinitionSchema);

/** Decode tool definitions received through a host or browser message boundary. */
export function parseBrowserToolDefinitions(
	input: Parameters<typeof browserToolDefinitionsSchema.parse>[0]
): BrowserToolDefinition[] {
	return browserToolDefinitionsSchema.parse(input);
}

export interface BrowserToolCall {
	arguments: BrowserToolDefinition;
	name: string;
}

function progressValue(value: ProgressInfo): number | undefined {
	return "progress" in value
		? Math.max(0, Math.min(100, value.progress))
		: undefined;
}

function readGeneratedText(output: TextGenerationOutput): string {
	const generated = output[0];
	if (!generated) {
		return "";
	}
	const text = generated.generated_text;
	if (!Array.isArray(text)) {
		return text;
	}
	const content = text.at(-1)?.content;
	return content !== undefined && !Array.isArray(content) ? content : "";
}

const toolCallSchema = z.object({
	name: z.string().nullish(),
	tool: z.string().optional(),
	arguments: z.record(z.string(), z.json()).nullish(),
	input: z.record(z.string(), z.json()).optional(),
});

/**
 * Returns the index just past the `}` that closes the object opening at
 * `start`, or -1 when it never closes. Braces inside JSON strings are ignored.
 */
function balancedObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === "{") {
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return index + 1;
			}
		}
	}
	return -1;
}

function readToolCall(candidate: string): BrowserToolCall | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		// Plain chat text is valid; malformed JSON is not a tool call.
		return;
	}
	const result = toolCallSchema.safeParse(parsed);
	if (!result.success) {
		return;
	}
	const name = result.data.name || result.data.tool;
	if (!name) {
		return;
	}
	return {
		arguments: result.data.arguments ?? result.data.input ?? {},
		name,
	};
}

function parseToolCalls(text: string): BrowserToolCall[] {
	const calls: BrowserToolCall[] = [];
	let start = text.indexOf("{");
	while (start !== -1) {
		const end = balancedObjectEnd(text, start);
		const call = end === -1 ? undefined : readToolCall(text.slice(start, end));
		if (call) {
			calls.push(call);
			start = text.indexOf("{", end);
		} else {
			start = text.indexOf("{", start + 1);
		}
	}
	return calls;
}

function plainTextPrompt(
	messages: readonly BrowserGenerationRequest["messages"][number][]
): string {
	const transcript = messages
		.map(({ content, role }) => `${role.toUpperCase()}: ${content}`)
		.join("\n\n");
	return `${transcript}\n\nASSISTANT:`;
}

function hasMissingChatTemplate(cause: unknown): boolean {
	return (
		cause instanceof Error &&
		cause.message.toLowerCase().includes("chat_template")
	);
}

function hasWebGpu(): boolean {
	return globalThis.navigator !== undefined && "gpu" in navigator;
}

/**
 * A browser-only Transformers.js runtime. Models are loaded lazily and cached
 * by Transformers.js in the browser; no prompt or generated text leaves the tab.
 */
export class BrowserLocalRuntime {
	private readonly listeners = new Set<BrowserRuntimeListener>();
	private readonly onStatus?: BrowserRuntimeListener;
	private readonly wasmBinaryUrl?: string;
	private readonly pipelines = new Map<
		string,
		Promise<TextGenerationPipeline>
	>();
	private readonly statuses = new Map<string, BrowserRuntimeStatus>();
	private readonly pipelineDevices = new Map<string, "webgpu" | "wasm">();

	constructor(options: BrowserLocalRuntimeOptions = {}) {
		this.onStatus = options.onStatus;
		this.wasmBinaryUrl = options.wasmBinaryUrl;
	}

	getStatus(modelId: string): BrowserRuntimeStatus | undefined {
		return this.statuses.get(modelId);
	}

	subscribe(listener: BrowserRuntimeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private publish(status: BrowserRuntimeStatus): void {
		this.statuses.set(status.modelId, status);
		this.onStatus?.(status);
		for (const listener of this.listeners) {
			listener(status);
		}
	}

	private async createPipeline(
		modelId: string,
		deviceOverride?: "wasm"
	): Promise<TextGenerationPipeline> {
		if (!isValidBrowserModelId(modelId)) {
			throw new Error("Invalid Hugging Face browser model id.");
		}
		const transformers = await import("@huggingface/transformers");
		transformers.env.useBrowserCache = true;
		transformers.env.useFSCache = false;
		transformers.env.useWasmCache = !this.wasmBinaryUrl;
		if (this.wasmBinaryUrl && transformers.env.backends.onnx?.wasm) {
			transformers.env.backends.onnx.wasm.wasmPaths = {
				wasm: this.wasmBinaryUrl,
			};
			// Extension service workers cannot spawn ORT's additional workers.
			transformers.env.backends.onnx.wasm.numThreads = 1;
		}
		const definition = createBrowserModelDefinition(modelId);
		const devices: Array<"webgpu" | "wasm"> = deviceOverride
			? [deviceOverride]
			: hasWebGpu()
				? ["webgpu", "wasm"]
				: ["wasm"];
		let lastError = "unknown browser runtime error";
		for (const device of devices) {
			this.publish({
				modelId,
				status: "preparing",
				statusMessage: `Preparing on ${device}.`,
			});
			try {
				const generator = await transformers.pipeline(
					"text-generation",
					modelId,
					{
						device,
						dtype:
							device === "webgpu"
								? "q4f16"
								: modelId === "onnx-community/SmolLM2-135M-Instruct-ONNX"
									? "q8"
									: "q4",
						progress_callback: (info: ProgressInfo) => {
							const progress = progressValue(info);
							this.publish({
								modelId,
								progress,
								status: "preparing",
								statusMessage:
									progress == null
										? `Downloading model files on ${device}…`
										: `Downloading model files (${Math.round(progress)}%).`,
							});
						},
					}
				);
				this.pipelineDevices.set(modelId, device);
				return generator;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				if (device === "webgpu") {
					this.publish({
						modelId,
						status: "preparing",
						statusMessage:
							"WebGPU could not load this model; retrying with WASM…",
					});
				}
			}
		}
		this.publish({ modelId, status: "failed", statusMessage: lastError });
		throw new Error(`${definition.name} could not be prepared: ${lastError}`);
	}

	async prepare(modelId: string): Promise<void> {
		let loading = this.pipelines.get(modelId);
		if (!loading) {
			this.publish({
				modelId,
				status: "preparing",
				statusMessage: "Starting browser engine…",
			});
			loading = this.createPipeline(modelId)
				.then((generator) => {
					this.publish({
						modelId,
						status: "ready",
						statusMessage: "Ready in this browser.",
					});
					return generator;
				})
				.catch((error) => {
					this.pipelines.delete(modelId);
					throw error;
				});
			this.pipelines.set(modelId, loading);
		}
		await loading;
	}

	async generate(
		request: BrowserGenerationRequest,
		signal?: AbortSignal
	): Promise<BrowserGenerationResult> {
		signal?.throwIfAborted();
		await this.prepare(request.modelId);
		if (signal?.aborted) {
			throw new DOMException("Generation cancelled.", "AbortError");
		}
		const generator = await this.pipelines.get(request.modelId);
		if (!generator) {
			throw new Error("Browser model is not loaded.");
		}
		const transformers = await import("@huggingface/transformers");
		const streamer = new transformers.TextStreamer(generator.tokenizer, {
			callback_function: () => undefined,
			skip_prompt: true,
			skip_special_tokens: true,
		});
		signal?.throwIfAborted();
		// Transformers checks criteria after every decoding step. Cancellation
		// stops at the next token boundary; an active ONNX step finishes first.
		class AbortStoppingCriteria extends transformers.StoppingCriteria {
			_call(inputIds: number[][]): boolean[] {
				return inputIds.map(() => signal?.aborted === true);
			}
		}
		const generationOptions = {
			stopping_criteria: new AbortStoppingCriteria(),
			do_sample: false,
			max_new_tokens: 192,
			no_repeat_ngram_size: 4,
			repetition_penalty: 1.15,
			streamer,
			tools: request.tools,
		};
		let output: TextGenerationOutput;
		let plainPrompt: string | undefined;
		try {
			output = await generator(request.messages, generationOptions);
		} catch (error) {
			// Some small ONNX exports (including the lightweight default) omit a
			// tokenizer chat template. Keep the structured message path first for
			// models that support it, then use a simple role transcript only for
			// this known compatibility failure.
			signal?.throwIfAborted();
			if (!hasMissingChatTemplate(error)) {
				throw error;
			}
			plainPrompt = plainTextPrompt(request.messages);
			output = await generator(plainPrompt, generationOptions);
		}
		signal?.throwIfAborted();
		let text = readGeneratedText(output);
		// Text-generation pipelines return the input string plus generated text.
		// Remove only the exact prompt we supplied; this keeps grounding context
		// from leaking into the visible answer.
		if (plainPrompt && text.startsWith(plainPrompt)) {
			text = text.slice(plainPrompt.length).trim();
		}
		if (
			!text.trim() &&
			this.pipelineDevices.get(request.modelId) === "webgpu"
		) {
			this.publish({
				modelId: request.modelId,
				status: "preparing",
				statusMessage: "WebGPU returned no text; retrying with WASM…",
			});
			const loading = this.createPipeline(request.modelId, "wasm");
			this.pipelines.set(request.modelId, loading);
			try {
				await loading;
			} catch (error) {
				this.pipelines.delete(request.modelId);
				throw error;
			}
			this.publish({
				modelId: request.modelId,
				status: "ready",
				statusMessage: "Ready in this browser with WASM.",
			});
			return this.generate(request, signal);
		}
		if (!text.trim()) {
			throw new Error(
				"The browser model returned no text. Try another prompt or model."
			);
		}
		return { text, toolCalls: parseToolCalls(text) };
	}
}

export function createBrowserLocalRuntime(
	options?: BrowserLocalRuntimeOptions
): BrowserLocalRuntime {
	return new BrowserLocalRuntime(options);
}

export { hasWebGpu };

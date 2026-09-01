/**
 * `Agent` — the declarative agent runtime for `@ryu/sdk`.
 *
 * Unlike `defineAgent` (a declaration wrapper whose `run()` you write by hand),
 * `Agent` OWNS the loop: give it instructions, a model, a target node, and a
 * set of tools, then call `generate()` / `stream()`. Inference is pointed at the
 * node's gateway; tool calls resolve to local `defineTool` runnables or existing
 * Ryu tools (`ryuTool`) executed through Core.
 *
 * Mirrors Mastra's config-object + `.generate()`/`.stream()` shape; `query()`
 * (see query.ts) wraps the same runtime in a Claude-Agent-SDK-style streaming
 * call.
 */

import { HarnessAPI, type HarnessApprovalOption } from "@ryuhq/client";
import { defineModel } from "../model/client.ts";
import { resolveGatewayToken, resolveGatewayUrl } from "../model/gateway.ts";
import {
	createPrimitives,
	httpPrimitiveTransport,
} from "../runnable/primitives.ts";
import type { GatewayClient } from "../runnable/runnable-types.ts";
import {
	type AgentEvent,
	type AgentEventApprovalRequested,
	type AgentEventAuthRequired,
	type LoopConfig,
	runAgentLoop,
} from "./loop.ts";
import type { LoopMessage, ModelUsage } from "./model-call.ts";
import type {
	AgentApprovalHandler,
	AgentTool,
	ToolExecContext,
} from "./tools.ts";

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_CORE_URL = "http://127.0.0.1:7980";

/** A target node for inference / tool execution: a base URL + optional token. */
export interface Endpoint {
	baseUrl?: string;
	token?: string;
}

/** Declarative configuration for an `Agent`. */
export interface AgentConfig {
	/** Core agent id — REQUIRED when using `ryuTool` remote tools (governance). */
	agentId?: string;
	/** Optional human decision callback for SDK-managed tool approvals. */
	approvalHandler?: AgentApprovalHandler;
	/** Core endpoint for tool discovery/execution. Defaults to env/localhost. */
	core?: Endpoint;
	/** System prompt / persona. */
	instructions?: string;
	/** Hard ceiling on model→tool rounds (default 10). */
	maxSteps?: number;
	/** Model id routed by the node's gateway. */
	model: string;
	/** Display name. */
	name: string;
	/** Target node for inference. Defaults to the local gateway. */
	node?: Endpoint;
	/** Optional JSON Schema for the final structured output. */
	outputSchema?: Record<string, unknown>;
	/**
	 * Reverse-domain plugin id. When set, the composable primitive surface
	 * (`ctx.rag`, `ctx.memory`, `ctx.engines`, …) is mounted on the run context,
	 * routed through this node via the governed host bridge / capability broker.
	 * Omitted = no primitives mounted (the bridge families authenticate a plugin
	 * id, so a half-wired transport is never attached).
	 */
	pluginId?: string;
	/** Optional terminal run id to resume as a new attempt on the first call. */
	resumeRunId?: string;
	/** Existing Core harness session used for durable start/resume semantics. */
	sessionId?: string;
	/** Tools keyed by the model-facing name. */
	tools?: Record<string, AgentTool>;
	/** Composio connected-account entity selector. */
	userId?: string;
}

/** Result of a non-streaming `generate()`. */
export interface GenerateResult {
	/** Present when a durable run paused for human approval. */
	approvalRequired?: AgentEventApprovalRequested;
	/** Present when the run paused for an account connection. */
	authRequired?: AgentEventAuthRequired;
	/** Parsed structured output when `outputSchema` was configured. */
	output?: unknown;
	/** Number of model→tool rounds taken. */
	steps: number;
	/** Final assistant text. */
	text: string;
	/** Aggregate token usage across all rounds (when reported). */
	usage?: ModelUsage;
}

/** Read `process.env` defensively (SDK may run outside Node typings). */
function env(key: string): string | undefined {
	const value = (globalThis as { process?: { env?: Record<string, string> } })
		.process?.env?.[key];
	return value && value !== "" ? value : undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Build a `GatewayClient` for local tools that lazily constructs the native
 * `ModelClient` only on first use — so an agent with no gateway-calling local
 * tools never touches the native addon.
 */
function lazyGatewayClient(
	model: string,
	baseUrl: string,
	token?: string
): GatewayClient {
	let client: ReturnType<typeof defineModel> | null = null;
	const get = () => {
		client ??= defineModel(model, { baseUrl, token });
		return client;
	};
	return {
		chat: (messages) => get().chat(messages),
		stream: (messages) => get().stream(messages),
	};
}

function selectApprovalOption(
	decision: boolean | string,
	options: HarnessApprovalOption[]
): string | undefined {
	if (typeof decision === "string") {
		const optionId = decision.trim();
		if (!optionId) {
			return undefined;
		}
		return options.length === 0 ||
			options.some((option) => option.optionId === optionId)
			? optionId
			: undefined;
	}
	if (!decision) {
		return undefined;
	}
	return options.find((option) => {
		const kind = option.kind.toLowerCase().replaceAll("-", "_");
		return kind === "allow_once" || kind === "allow_always";
	})?.optionId;
}

function parseStructuredOutput(value: unknown): unknown {
	if (typeof value !== "string") {
		return value;
	}
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/** A declarative, loop-owning agent. */
export class Agent {
	readonly config: AgentConfig;

	constructor(config: AgentConfig) {
		this.config = config;
	}

	/** Assemble the loop config for a given prompt. */
	private buildLoopConfig(prompt: string, signal?: AbortSignal): LoopConfig {
		const gatewayBaseUrl = this.config.node?.baseUrl ?? resolveGatewayUrl();
		const gatewayToken = this.config.node?.token ?? resolveGatewayToken();
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? env("RYU_TOKEN");

		const messages: LoopMessage[] = [];
		if (this.config.instructions) {
			messages.push({ role: "system", content: this.config.instructions });
		}
		messages.push({ role: "user", content: prompt });

		const toolCtx: ToolExecContext = {
			agentId: this.config.agentId,
			coreBaseUrl,
			coreToken,
			userId: this.config.userId,
			signal,
			runnableContext: {
				gateway: lazyGatewayClient(
					this.config.model,
					gatewayBaseUrl,
					gatewayToken
				),
				signal,
				// Mount the composable primitive surface only when a plugin id is
				// present — the bridge families authenticate it, so we never attach a
				// half-wired transport (advisor guidance / §6b).
				...(this.config.pluginId
					? createPrimitives(
							httpPrimitiveTransport({
								nodeUrl: coreBaseUrl,
								token: coreToken,
								pluginId: this.config.pluginId,
							})
						)
					: {}),
			},
		};

		return {
			model: this.config.model,
			gatewayBaseUrl,
			gatewayToken,
			messages,
			tools: this.config.tools ?? {},
			approvalHandler: this.config.approvalHandler,
			outputSchema: this.config.outputSchema,
			toolCtx,
			maxSteps: this.config.maxSteps ?? DEFAULT_MAX_STEPS,
			signal,
		};
	}

	/** Consume a Core-owned run's durable event stream into SDK events. */
	private async *consumeHarnessRun(
		harness: HarnessAPI,
		runId: string,
		signal?: AbortSignal,
		after = 0
	): AsyncGenerator<AgentEvent> {
		let text = "";
		let steps = 0;
		for await (const event of harness.events(runId, after, signal)) {
			switch (event.type) {
				case "text_delta":
					text += event.delta;
					yield { type: "text", content: event.delta };
					break;
				case "input_accepted":
					// The input boundary is durable provenance for reconnecting
					// clients, not a second user-visible message.
					break;
				case "tool_call_started":
					steps += 1;
					yield {
						type: "tool_call",
						id: event.toolCallId,
						name: event.name,
						input: {},
					};
					break;
				case "tool_call_completed":
					yield {
						type: "tool_result",
						id: event.toolCallId,
						name: event.name,
						output: {
							ok: event.ok,
							...(event.resultHash ? { resultHash: event.resultHash } : {}),
						},
					};
					break;
				case "approval_requested": {
					const approvalOptions: HarnessApprovalOption[] = event.options ?? [];
					yield {
						type: "approval_requested",
						approvalId: event.approvalId,
						name: "runtime",
						options: approvalOptions,
						summary: event.summary,
					};
					if (!this.config.approvalHandler) {
						return;
					}
					try {
						const decision = await this.config.approvalHandler({
							approvalId: event.approvalId,
							input: undefined,
							name: "runtime",
							options: approvalOptions,
							summary: event.summary,
						});
						const optionId = selectApprovalOption(decision, approvalOptions);
						if (
							typeof decision === "string" &&
							approvalOptions.length > 0 &&
							!optionId
						) {
							yield {
								type: "error",
								message: "approval handler returned an unknown option id",
							};
							return;
						}
						const resolved = await harness.resolvePermission(
							event.approvalId,
							optionId
						);
						if (!resolved) {
							yield {
								type: "error",
								message: "approval request is no longer active",
							};
							return;
						}
					} catch (error) {
						await harness
							.resolvePermission(event.approvalId)
							.catch(() => false);
						yield { type: "error", message: describeError(error) };
						return;
					}
					break;
				}
				case "run_failed":
					yield { type: "error", message: event.message };
					return;
				case "run_completed":
					if (this.config.outputSchema) {
						const output = parseStructuredOutput(event.output ?? text);
						if (output === undefined) {
							yield {
								type: "error",
								message: "model did not return valid structured JSON output",
							};
							return;
						}
						yield { type: "result", text, steps, output };
					} else {
						yield { type: "result", text, steps };
					}
					return;
				case "run_canceled":
					yield { type: "error", message: "durable run canceled" };
					return;
				case "run_interrupted":
					yield { type: "error", message: "durable run interrupted" };
					return;
				case "run_started":
				case "checkpoint":
				case "ui_frame":
					break;
			}
		}
	}

	/** Stream a Core-owned durable harness session when one is configured. */
	private async *streamHarness(
		prompt: string,
		signal?: AbortSignal,
		resumeRunId?: string
	): AsyncGenerator<AgentEvent> {
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? env("RYU_TOKEN");
		const harness = new HarnessAPI({ baseUrl: coreBaseUrl, token: coreToken });
		let runId: string | undefined;
		try {
			const started = await harness.startRun(
				this.config.sessionId ?? "",
				{ prompt },
				resumeRunId ? { resumeRunId } : {}
			);
			const currentRunId = started.run.id;
			runId = currentRunId;
			yield* this.consumeHarnessRun(harness, currentRunId, signal);
		} catch (error) {
			if (signal?.aborted) {
				if (runId) {
					await harness.cancel(runId).catch(() => false);
				}
				return;
			}
			yield { type: "error", message: describeError(error) };
		}
	}

	/** Resolve a pending native-runtime permission request for this session. */
	async resolvePermission(
		requestId: string,
		optionId?: string
	): Promise<boolean> {
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? env("RYU_TOKEN");
		return new HarnessAPI({
			baseUrl: coreBaseUrl,
			token: coreToken,
		}).resolvePermission(requestId, optionId);
	}

	/** Continue observing a pending durable run without creating a new attempt. */
	streamRun(
		runId: string,
		after = 0,
		signal?: AbortSignal
	): AsyncGenerator<AgentEvent> {
		const coreBaseUrl =
			this.config.core?.baseUrl ?? env("RYU_CORE_URL") ?? DEFAULT_CORE_URL;
		const coreToken = this.config.core?.token ?? env("RYU_TOKEN");
		const harness = new HarnessAPI({ baseUrl: coreBaseUrl, token: coreToken });
		const consume = this.consumeHarnessRun(harness, runId, signal, after);
		return (async function* () {
			try {
				yield* consume;
			} catch (error) {
				yield { type: "error", message: describeError(error) };
			}
		})();
	}

	/** Stream loop events (text / tool_call / tool_result / auth_required / …). */
	stream(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
		if (this.config.sessionId) {
			return this.streamHarness(prompt, signal, this.config.resumeRunId);
		}
		return runAgentLoop(this.buildLoopConfig(prompt, signal));
	}

	/** Resume a terminal run as a new durable attempt while preserving lineage. */
	resume(
		runId: string,
		prompt: string,
		signal?: AbortSignal
	): AsyncGenerator<AgentEvent> {
		if (!this.config.sessionId) {
			return (async function* () {
				yield {
					type: "error" as const,
					message: "resuming a durable run requires sessionId",
				};
			})();
		}
		return this.streamHarness(prompt, signal, runId);
	}

	/** Run to completion and return the final text, step count, and usage. */
	async generate(
		prompt: string,
		signal?: AbortSignal
	): Promise<GenerateResult> {
		let text = "";
		let steps = 0;
		let usage: ModelUsage | undefined;
		let authRequired: AgentEventAuthRequired | undefined;
		let approvalRequired: AgentEventApprovalRequested | undefined;
		let output: unknown;

		for await (const event of this.stream(prompt, signal)) {
			if (event.type === "result") {
				text = event.text;
				steps = event.steps;
				usage = event.usage;
				output = event.output;
			} else if (event.type === "auth_required") {
				authRequired = event;
			} else if (event.type === "approval_requested") {
				approvalRequired = event;
			} else if (event.type === "error") {
				throw new Error(
					`[ryu-sdk] agent "${this.config.name}": ${event.message}`
				);
			}
		}

		return { text, steps, usage, authRequired, approvalRequired, output };
	}
}

/** Factory alias for `new Agent(config)`. */
export function createAgent(config: AgentConfig): Agent {
	return new Agent(config);
}

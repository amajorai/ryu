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

import { defineModel } from "../model/client.ts";
import { resolveGatewayToken, resolveGatewayUrl } from "../model/gateway.ts";
import type { GatewayClient } from "../runnable/runnable-types.ts";
import {
	type AgentEvent,
	type AgentEventAuthRequired,
	type LoopConfig,
	runAgentLoop,
} from "./loop.ts";
import type { LoopMessage, ModelUsage } from "./model-call.ts";
import type { AgentTool, ToolExecContext } from "./tools.ts";

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
	/** Tools keyed by the model-facing name. */
	tools?: Record<string, AgentTool>;
	/** Composio connected-account entity selector. */
	userId?: string;
}

/** Result of a non-streaming `generate()`. */
export interface GenerateResult {
	/** Present when the run paused for an account connection. */
	authRequired?: AgentEventAuthRequired;
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
			},
		};

		return {
			model: this.config.model,
			gatewayBaseUrl,
			gatewayToken,
			messages,
			tools: this.config.tools ?? {},
			toolCtx,
			maxSteps: this.config.maxSteps ?? DEFAULT_MAX_STEPS,
			signal,
		};
	}

	/** Stream loop events (text / tool_call / tool_result / auth_required / …). */
	stream(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
		return runAgentLoop(this.buildLoopConfig(prompt, signal));
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

		for await (const event of this.stream(prompt, signal)) {
			if (event.type === "result") {
				text = event.text;
				steps = event.steps;
				usage = event.usage;
			} else if (event.type === "auth_required") {
				authRequired = event;
			} else if (event.type === "error") {
				throw new Error(
					`[ryu-sdk] agent "${this.config.name}": ${event.message}`
				);
			}
		}

		return { text, steps, usage, authRequired };
	}
}

/** Factory alias for `new Agent(config)`. */
export function createAgent(config: AgentConfig): Agent {
	return new Agent(config);
}

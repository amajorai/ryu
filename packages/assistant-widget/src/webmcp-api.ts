import { z } from "zod";
import type { WebMcpJsonValue, WebMcpRecord } from "./webmcp-contract.ts";

/** Current WebMCP page API shape, shared by website providers and consumers. */
export interface WebMcpToolAnnotations {
	consequentialHint?: boolean;
	debugging?: boolean;
	readOnlyHint?: boolean;
	untrustedContentHint?: boolean;
}

export interface WebMcpToolDefinition {
	annotations?: WebMcpToolAnnotations;
	description: string;
	execute: (
		input: WebMcpRecord,
		options: { signal: AbortSignal }
	) => Promise<WebMcpJsonValue>;
	inputSchema?: WebMcpRecord;
	name: string;
	title?: string;
}

/** Complete exposed page-tool descriptor. The owner-window value is a live
 * browser handle retained by identity; it is not a JSON transport field. */
export interface WebMcpExposedTool {
	annotations?: WebMcpToolAnnotations;
	description: string;
	inputSchema?: WebMcpRecord | string;
	name: string;
	origin: string;
	title?: string;
	window: object;
}

export interface WebMcpModelContext {
	addEventListener?: (
		type: "toolchange",
		listener: EventListenerOrEventListenerObject
	) => void;
	executeTool?: (
		tool: WebMcpExposedTool,
		inputObject?: WebMcpRecord,
		options?: { signal?: AbortSignal }
	) => Promise<WebMcpJsonValue>;
	getTools?: (options?: {
		fromOrigins?: string[];
	}) => Promise<WebMcpExposedTool[]>;
	registerTool?: (
		tool: WebMcpToolDefinition,
		options?: { exposedTo?: string[]; signal?: AbortSignal }
	) => void | Promise<void>;
	removeEventListener?: (
		type: "toolchange",
		listener: EventListenerOrEventListenerObject
	) => void;
}

declare global {
	interface Document {
		modelContext?: WebMcpModelContext;
	}
	interface Navigator {
		modelContext?: WebMcpModelContext;
	}
}

const BrowserContextSchema = z.object({
	registerTool: z.instanceof(Function),
	getTools: z.instanceof(Function),
	executeTool: z.instanceof(Function),
});

/** Prefer the current Document API while retaining the deprecated Navigator alias. */
export function getWebMcpModelContext(): WebMcpModelContext | null {
	const documentContext = globalThis.document?.modelContext;
	if (BrowserContextSchema.safeParse(documentContext).success) {
		return documentContext ?? null;
	}
	const navigatorContext = globalThis.navigator?.modelContext;
	return BrowserContextSchema.safeParse(navigatorContext).success
		? (navigatorContext ?? null)
		: null;
}

/** Register a bounded tool set and unregister it when the owning surface leaves. */
export function registerWebMcpTools(
	context: WebMcpModelContext | null,
	tools: readonly WebMcpToolDefinition[]
): () => void {
	if (
		!(
			context &&
			z.instanceof(Function).safeParse(context.registerTool).success &&
			context.registerTool
		)
	) {
		return () => undefined;
	}

	const controller = new AbortController();
	for (const tool of tools) {
		try {
			void Promise.resolve(
				context.registerTool(tool, { signal: controller.signal })
			).catch(() => undefined);
		} catch {
			// One rejected definition must not prevent the remaining tools from registering.
		}
	}
	return () => controller.abort();
}

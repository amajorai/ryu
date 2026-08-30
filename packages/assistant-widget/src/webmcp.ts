"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_PAGE_TOOLS = 64;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 500;
const MAX_TOOL_TITLE_CHARS = 120;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_TOOL_FIELDS = 12;
const MAX_ENUM_VALUES = 20;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export interface WebMcpPageToolAnnotations {
	readOnlyHint?: boolean;
	untrustedContentHint?: boolean;
}

export interface WebMcpPageTool {
	annotations?: WebMcpPageToolAnnotations;
	description: string;
	inputSchema: Record<string, unknown>;
	name: string;
	title?: string;
}

export interface WebMcpPageToolsState {
	available: boolean;
	error: string | null;
	execute: (
		name: string,
		input: Record<string, unknown>,
		signal?: AbortSignal
	) => Promise<string>;
	loading: boolean;
	tools: readonly WebMcpPageTool[];
}

interface ModelContextLike {
	addEventListener?: (type: "toolchange", listener: () => void) => void;
	executeTool?: (
		tool: unknown,
		inputObject?: Record<string, unknown>,
		options?: { signal?: AbortSignal }
	) => Promise<unknown>;
	getTools?: () => Promise<unknown>;
	removeEventListener?: (type: "toolchange", listener: () => void) => void;
}

interface RegisteredPageTool extends WebMcpPageTool {
	raw: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	return value.replace(/[\r\n]+/g, " ").slice(0, maxLength);
}

function boundedSchema(value: unknown): Record<string, unknown> {
	const source = asRecord(value);
	if (!source) {
		return { additionalProperties: false, properties: {}, type: "object" };
	}
	const sourceProperties = asRecord(source.properties);
	const properties: Record<string, unknown> = {};
	for (const [name, rawProperty] of Object.entries(
		sourceProperties ?? {}
	).slice(0, MAX_TOOL_FIELDS)) {
		const property = asRecord(rawProperty);
		if (!property) {
			continue;
		}
		const normalized: Record<string, unknown> = {};
		const type = boundedText(property.type, 20);
		if (type) {
			normalized.type = type;
		}
		const description = boundedText(property.description, 150);
		if (description) {
			normalized.description = description;
		}
		if (Array.isArray(property.enum)) {
			const values = property.enum
				.filter((item): item is string => typeof item === "string")
				.slice(0, MAX_ENUM_VALUES);
			if (values.length > 0) {
				normalized.enum = values;
			}
		}
		for (const key of ["minimum", "maximum"]) {
			if (typeof property[key] === "number" && Number.isFinite(property[key])) {
				normalized[key] = property[key];
			}
		}
		properties[name.slice(0, 80)] = normalized;
	}
	const required = Array.isArray(source.required)
		? source.required
				.filter((item): item is string => typeof item === "string")
				.slice(0, MAX_TOOL_FIELDS)
		: [];
	return {
		additionalProperties: false,
		properties,
		...(required.length > 0 ? { required } : {}),
		type: "object",
	};
}

/** Normalize page-provided metadata before rendering it inside the assistant. */
export function normalizeWebMcpTool(value: unknown): WebMcpPageTool | null {
	const source = asRecord(value);
	const name = boundedText(source?.name, MAX_TOOL_NAME_CHARS);
	const description = boundedText(
		source?.description,
		MAX_TOOL_DESCRIPTION_CHARS
	);
	if (!(name && description && TOOL_NAME_PATTERN.test(name))) {
		return null;
	}
	const title = boundedText(source?.title, MAX_TOOL_TITLE_CHARS);
	const rawAnnotations = asRecord(source?.annotations);
	const annotations = rawAnnotations
		? {
				...(rawAnnotations.readOnlyHint === undefined
					? {}
					: { readOnlyHint: rawAnnotations.readOnlyHint === true }),
				...(rawAnnotations.untrustedContentHint === undefined
					? {}
					: {
							untrustedContentHint:
								rawAnnotations.untrustedContentHint === true,
						}),
			}
		: undefined;
	return {
		...(annotations ? { annotations } : {}),
		description,
		inputSchema: boundedSchema(source?.inputSchema),
		name,
		...(title ? { title } : {}),
	};
}

function modelContext(): ModelContextLike | null {
	if (typeof document !== "undefined") {
		const documentContext = (
			document as Document & { modelContext?: ModelContextLike }
		).modelContext;
		if (documentContext) {
			return documentContext;
		}
	}
	if (typeof navigator !== "undefined") {
		return (
			(navigator as Navigator & { modelContext?: ModelContextLike })
				.modelContext ?? null
		);
	}
	return null;
}

function boundedResult(value: unknown): string {
	const text =
		typeof value === "string"
			? value
			: (() => {
					try {
						return JSON.stringify(value) ?? "The page tool returned no result.";
					} catch {
						return "The page tool returned an unreadable result.";
					}
				})();
	return text.length <= MAX_TOOL_RESULT_CHARS
		? text
		: `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated]`;
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message
		? error.message.slice(0, 300)
		: "The page tool could not be read.";
}

/**
 * Read and execute tools registered by the current document. This is an in-page
 * client: it never reaches across origins and never invents a tool implementation.
 */
export function useWebMcpPageTools(): WebMcpPageToolsState {
	const [available, setAvailable] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [tools, setTools] = useState<readonly WebMcpPageTool[]>([]);
	const contextRef = useRef<ModelContextLike | null>(null);
	const registeredToolsRef = useRef<RegisteredPageTool[]>([]);

	useEffect(() => {
		const context = modelContext();
		if (!(context?.getTools && context.executeTool)) {
			return;
		}
		contextRef.current = context;
		let disposed = false;

		const refresh = async () => {
			setLoading(true);
			try {
				const result = await context.getTools?.();
				const next: RegisteredPageTool[] = [];
				if (Array.isArray(result)) {
					for (const candidate of result.slice(0, MAX_PAGE_TOOLS)) {
						const normalized = normalizeWebMcpTool(candidate);
						if (normalized) {
							next.push({ ...normalized, raw: candidate });
						}
					}
				}
				registeredToolsRef.current = next;
				if (!disposed) {
					setAvailable(true);
					setError(null);
					setTools(next.map(({ raw: _raw, ...tool }) => tool));
				}
			} catch (cause) {
				if (!disposed) {
					setAvailable(true);
					setError(describeError(cause));
					setTools([]);
				}
			} finally {
				if (!disposed) {
					setLoading(false);
				}
			}
		};

		const onToolChange = () => {
			void refresh();
		};
		context.addEventListener?.("toolchange", onToolChange);
		void refresh();
		return () => {
			disposed = true;
			context.removeEventListener?.("toolchange", onToolChange);
			contextRef.current = null;
			registeredToolsRef.current = [];
		};
	}, []);

	const execute = useCallback(
		async (
			name: string,
			input: Record<string, unknown>,
			signal?: AbortSignal
		): Promise<string> => {
			const context = contextRef.current;
			const tool = registeredToolsRef.current.find(
				(candidate) => candidate.name === name
			);
			if (!(context?.executeTool && tool)) {
				throw new Error("This page has no registered tool with that name.");
			}
			const result = signal
				? await context.executeTool(tool.raw, input, { signal })
				: await context.executeTool(tool.raw, input);
			return boundedResult(result);
		},
		[]
	);

	return { available, error, execute, loading, tools };
}

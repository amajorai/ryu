"use client";

import {
	isNativeBoolean,
	isNativeNumber,
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	getWebMcpModelContext,
	type WebMcpExposedTool,
	type WebMcpModelContext,
	type WebMcpToolAnnotations,
} from "./webmcp-api.ts";
import {
	type WebMcpInputProperty,
	type WebMcpInputSchema,
	type WebMcpJsonValue,
	type WebMcpRecord,
	WebMcpRecordSchema,
} from "./webmcp-contract.ts";

const MAX_PAGE_TOOLS = 64;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_DESCRIPTION_CHARS = 500;
const MAX_TOOL_TITLE_CHARS = 120;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_TOOL_ORIGIN_CHARS = 256;
const MAX_TOOL_FIELDS = 12;
const MAX_ENUM_VALUES = 20;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export type WebMcpPageToolAnnotations = WebMcpToolAnnotations;

export interface WebMcpPageTool {
	annotations?: WebMcpPageToolAnnotations;
	description: string;
	id: string;
	inputSchema: WebMcpInputSchema;
	name: string;
	origin?: string;
	title?: string;
}

type NormalizedWebMcpPageTool = Omit<WebMcpPageTool, "id">;

export interface WebMcpPageToolsState {
	available: boolean;
	error: string | null;
	execute: (
		id: string,
		input: WebMcpRecord,
		signal?: AbortSignal
	) => Promise<string>;
	loading: boolean;
	tools: readonly WebMcpPageTool[];
}

interface RegisteredPageTool extends WebMcpPageTool {
	raw: WebMcpExposedTool;
}

function asRecord(value: WebMcpJsonValue | undefined): WebMcpRecord | null {
	const parsed = WebMcpRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

// Only primitive brands are observed here. Keep the live descriptor and
// annotations as their original receivers; full JSON admission belongs to
// the actual schema/input/result payloads, not the browser handle.
function asToolRecord(value: WebMcpJsonValue | WebMcpExposedTool | undefined) {
	if (
		!isNativeObjectLike(value) ||
		Array.isArray(value) ||
		isNativeText(value) ||
		isNativeNumber(value) ||
		isNativeBoolean(value) ||
		value === null ||
		value === undefined
	) {
		return null;
	}
	return value;
}

function asAnnotationRecord(
	value: WebMcpJsonValue | WebMcpToolAnnotations | undefined
) {
	if (
		!isNativeObjectLike(value) ||
		Array.isArray(value) ||
		isNativeText(value) ||
		isNativeNumber(value) ||
		isNativeBoolean(value) ||
		value === null ||
		value === undefined
	) {
		return null;
	}
	return value;
}

function boundedText(
	value: WebMcpJsonValue | undefined,
	maxLength: number
): string | undefined {
	const parsed = z.string().safeParse(value);
	if (!(parsed.success && parsed.data.trim())) {
		return undefined;
	}
	return parsed.data.replace(/[\r\n]+/g, " ").slice(0, maxLength);
}

function boundedOrigin(value: WebMcpJsonValue | undefined): string | undefined {
	const parsed = z.string().max(MAX_TOOL_ORIGIN_CHARS).safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	try {
		const origin = new URL(parsed.data);
		return origin.origin === parsed.data ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

function boundedSchema(
	value: WebMcpJsonValue | undefined
): WebMcpInputSchema | null {
	let rawSchema = value;
	const encodedSchema = z.string().safeParse(rawSchema);
	if (encodedSchema.success) {
		try {
			rawSchema = JSON.parse(encodedSchema.data);
		} catch {
			return null;
		}
	}
	const source = asRecord(rawSchema);
	if (!source) {
		return { additionalProperties: false, properties: {}, type: "object" };
	}
	const sourceProperties = asRecord(source.properties);
	const properties: Record<string, WebMcpInputProperty> = Object.create(null);
	for (const [name, rawProperty] of Object.entries(
		sourceProperties ?? {}
	).slice(0, MAX_TOOL_FIELDS)) {
		if (
			name.length > 80 ||
			name === "__proto__" ||
			name === "constructor" ||
			name === "prototype"
		) {
			continue;
		}
		const property = asRecord(rawProperty);
		if (!property) {
			continue;
		}
		const normalized: WebMcpInputProperty = {};
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
				.flatMap((item) => {
					const parsed = z.string().safeParse(item);
					return parsed.success ? [parsed.data] : [];
				})
				.slice(0, MAX_ENUM_VALUES);
			if (values.length > 0) {
				normalized.enum = values;
			}
		}
		for (const key of ["minimum", "maximum"]) {
			const number = z.number().finite().safeParse(property[key]);
			if (number.success && (key === "minimum" || key === "maximum")) {
				normalized[key] = number.data;
			}
		}
		properties[name] = normalized;
	}
	const requestedRequired = Array.isArray(source.required)
		? source.required.flatMap((item) => {
				const parsed = z.string().safeParse(item);
				return parsed.success ? [parsed.data] : [];
			})
		: [];
	const safePropertyNames = new Set(Object.keys(properties));
	if (requestedRequired.some((name) => !safePropertyNames.has(name))) {
		return null;
	}
	const required = [...new Set(requestedRequired)];
	const schema: WebMcpInputSchema = {
		additionalProperties: false,
		properties,
		type: "object",
	};
	if (required.length > 0) {
		schema.required = required;
	}
	return schema;
}

/** Normalize page-provided metadata before rendering it inside the assistant. */
export function normalizeWebMcpTool(
	value: WebMcpJsonValue | WebMcpExposedTool
): NormalizedWebMcpPageTool | null {
	const source = asToolRecord(value);
	const name = boundedText(source?.name, MAX_TOOL_NAME_CHARS);
	const description = boundedText(
		source?.description,
		MAX_TOOL_DESCRIPTION_CHARS
	);
	if (!(name && description && TOOL_NAME_PATTERN.test(name))) {
		return null;
	}
	const title = boundedText(source?.title, MAX_TOOL_TITLE_CHARS);
	const rawAnnotations = asAnnotationRecord(source?.annotations);
	const annotations: WebMcpPageToolAnnotations | undefined = rawAnnotations
		? {}
		: undefined;
	if (rawAnnotations && annotations) {
		if (rawAnnotations.consequentialHint !== undefined) {
			annotations.consequentialHint = rawAnnotations.consequentialHint === true;
		}
		if (rawAnnotations.debugging !== undefined) {
			annotations.debugging = rawAnnotations.debugging === true;
		}
		if (rawAnnotations.readOnlyHint !== undefined) {
			annotations.readOnlyHint = rawAnnotations.readOnlyHint === true;
		}
		if (rawAnnotations.untrustedContentHint !== undefined) {
			annotations.untrustedContentHint =
				rawAnnotations.untrustedContentHint === true;
		}
	}
	const inputSchema = boundedSchema(source?.inputSchema);
	if (!inputSchema) {
		return null;
	}
	const origin = boundedOrigin(source?.origin);
	const tool: NormalizedWebMcpPageTool = { description, inputSchema, name };
	if (annotations) {
		tool.annotations = annotations;
	}
	if (origin) {
		tool.origin = origin;
	}
	if (title) {
		tool.title = title;
	}
	return tool;
}

function boundedResult(value: WebMcpJsonValue): string {
	let normalized = value;
	const encodedResult = z.string().safeParse(value);
	if (encodedResult.success) {
		try {
			normalized = JSON.parse(encodedResult.data);
		} catch {
			// Some WebMCP previews return a plain string instead of a JSON string.
		}
	}
	const plainResult = z.string().safeParse(normalized);
	const text = plainResult.success
		? plainResult.data
		: (() => {
				try {
					return (
						JSON.stringify(normalized) ?? "The page tool returned no result."
					);
				} catch {
					return "The page tool returned an unreadable result.";
				}
			})();
	return text.length <= MAX_TOOL_RESULT_CHARS
		? text
		: `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated]`;
}

function describeError(error: Error | null): string {
	return error?.message
		? error.message.slice(0, 300)
		: "The page tool could not be read.";
}

/**
 * Read and execute tools exposed to the current document by WebMCP. The browser
 * controls origin exposure; the widget invokes only a listed tool after a user action.
 */
export function useWebMcpPageTools(): WebMcpPageToolsState {
	const [available, setAvailable] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [tools, setTools] = useState<readonly WebMcpPageTool[]>([]);
	const contextRef = useRef<WebMcpModelContext | null>(null);
	const registeredToolsRef = useRef<RegisteredPageTool[]>([]);

	useEffect(() => {
		const context = getWebMcpModelContext();
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
					for (const [index, candidate] of result
						.slice(0, MAX_PAGE_TOOLS)
						.entries()) {
						const normalized = normalizeWebMcpTool(candidate);
						if (normalized) {
							next.push({
								...normalized,
								id: `${normalized.origin ?? "unknown-origin"}\u0000${normalized.name}\u0000${index}`,
								raw: candidate,
							});
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
					const error = z.instanceof(Error).safeParse(cause);
					setError(describeError(error.success ? error.data : null));
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
			idOrName: string,
			input: WebMcpRecord,
			signal?: AbortSignal
		): Promise<string> => {
			const context = contextRef.current;
			const listedTools = registeredToolsRef.current;
			const toolById = listedTools.find(
				(candidate) => candidate.id === idOrName
			);
			const matchingNames = toolById
				? []
				: listedTools.filter((candidate) => candidate.name === idOrName);
			const tool =
				toolById ?? (matchingNames.length === 1 ? matchingNames[0] : undefined);
			if (matchingNames.length > 1) {
				throw new Error(
					"This page has multiple tools with that name. Select its listed origin."
				);
			}
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

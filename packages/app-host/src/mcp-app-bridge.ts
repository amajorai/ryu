import { z } from "zod";
import type { OpenedFileSnapshot } from "./opened-file.ts";
import {
	type Capability,
	dispatchRpc,
	type HostServices,
	type WidgetGlobalsPatch,
} from "./rpc.ts";

/** MCP JSON can carry absent optional properties until window transport serializes it. */
export type McpValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| McpValue[]
	| { [key: string]: McpValue };
const mcpValueSchema: z.ZodType<McpValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.undefined(),
		z.array(mcpValueSchema),
		z.record(z.string(), mcpValueSchema),
	])
);
const mcpValueBoundarySchema = z
	.unknown()
	.transform((value) => mcpValueSchema.parse(value));
const mcpParamsSchema = z.record(z.string(), z.unknown());
const mcpParamsBoundarySchema = z.unknown().transform((params) => {
	const parsed = mcpParamsSchema.safeParse(params);
	return parsed.success ? parsed.data : {};
});
const mcpEnvelopeSchema = z.object({
	jsonrpc: z.literal("2.0"),
	method: z.string(),
	id: z.unknown().optional(),
	params: z.unknown().optional(),
});
const mcpEnvelopeBoundarySchema = z.unknown().transform((message) => {
	const parsed = mcpEnvelopeSchema.safeParse(message);
	return parsed.success ? parsed.data : null;
});
const mcpIdSchema = z.union([z.string(), z.number()]).optional();
export type McpHostMessage =
	| { jsonrpc: "2.0"; method: string; params: McpValue }
	| { jsonrpc: "2.0"; id: string | number; result: McpValue }
	| {
			jsonrpc: "2.0";
			id: string | number;
			error: { code: number; message: string };
	  };
interface McpToolResult {
	content: McpValue[];
	structuredContent?: McpValue;
	[key: string]: McpValue;
}
type McpEmptyCapability = Record<string, never>;
interface McpHostCapabilities {
	experimental: {
		"openai/modelContext"?: McpEmptyCapability;
		"openai/resource"?: McpEmptyCapability;
	};
	message?: { text: McpEmptyCapability };
	serverResources?: { subscribe: true };
	serverTools?: McpEmptyCapability;
	updateModelContext?: {
		text: McpEmptyCapability;
		image: McpEmptyCapability;
		resourceLink: McpEmptyCapability;
		resource: McpEmptyCapability;
		structuredContent: McpEmptyCapability;
	};
}
const openedFileSnapshotSchema = z.union([
	z.object({ uri: z.string(), revision: z.string(), text: z.string() }),
	z.object({ uri: z.string(), revision: z.string(), blob: z.string() }),
]);
const revisionSchema = z.object({ revision: z.string() });
const updateIdSchema = z.object({ updateId: z.string() });
const resourceMetaSchema = z
	.object({
		"openai/resource": z
			.object({ representation: z.unknown().optional() })
			.optional()
			.catch(undefined),
	})
	.optional()
	.catch(undefined);
const resourceRepresentationSchema = z.enum(["text", "blob"]).optional();
const messageMetaSchema = z
	.object({
		"openai/message": z
			.object({ target: z.unknown().optional() })
			.optional()
			.catch(undefined),
	})
	.optional()
	.catch(undefined);
const textContentSchema = z.array(
	z.object({ type: z.literal("text"), text: z.string() })
);
const globalsSchema = z
	.object({
		theme: z.enum(["light", "dark"]).optional().catch(undefined),
		locale: z.string().optional().catch(undefined),
		displayMode: z
			.enum(["inline", "fullscreen", "pip"])
			.optional()
			.catch(undefined),
		deepLink: z.object({ url: z.string() }).optional().catch(undefined),
		modelContext: mcpValueSchema.optional().catch(undefined),
		openedFile: z
			.object({
				uri: z.string(),
				name: z.string(),
				editable: z.boolean(),
				revision: z.string(),
			})
			.optional()
			.catch(undefined),
		toolInput: mcpValueSchema.optional().catch(undefined),
		toolOutput: mcpValueSchema.optional().catch(undefined),
	})
	.catch(() => ({}));
const toolResultSchema = z
	.object({ content: z.array(mcpValueSchema) })
	.catchall(mcpValueSchema);
const toolResultBoundarySchema = z
	.unknown()
	.transform((output): McpToolResult => {
		const result = toolResultSchema.safeParse(output);
		if (result.success) {
			return result.data;
		}
		const string = z.string().safeParse(output);
		const wrapped: McpToolResult = {
			content: [
				{
					type: "text",
					text: string.success ? string.data : (JSON.stringify(output) ?? ""),
				},
			],
		};
		const structured = z.record(z.string(), mcpValueSchema).safeParse(output);
		if (structured.success) {
			wrapped.structuredContent = structured.data;
		}
		return wrapped;
	});
const toolResult = toolResultBoundarySchema.parse;

function resourceRepresentation(
	snapshot: OpenedFileSnapshot,
	requested: z.infer<typeof resourceRepresentationSchema>
) {
	const text = "text" in snapshot ? snapshot.text : undefined;
	const blob = "blob" in snapshot ? snapshot.blob : undefined;
	if (requested === "text" && blob !== undefined) {
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(
				Uint8Array.from(atob(blob), (character) => character.charCodeAt(0))
			),
			mimeType: "text/plain",
		};
	}
	if (requested === "blob" && text !== undefined) {
		let binary = "";
		for (const byte of new TextEncoder().encode(text)) {
			binary += String.fromCharCode(byte);
		}
		return { blob: btoa(binary), mimeType: "application/octet-stream" };
	}
	return blob === undefined
		? { text: text ?? "", mimeType: "text/plain" }
		: { blob, mimeType: "application/octet-stream" };
}

/** Standard MCP Apps window transport. The caller must verify the iframe source. */
export function createMcpAppBridge(options: {
	granted: ReadonlySet<Capability>;
	services: () => HostServices;
	send: (message: McpHostMessage) => void;
}) {
	let initialized = false;
	let initializeComplete = false;
	const subscribedResources = new Set<string>();
	let inFlight = 0;
	const notify = (
		method: string,
		params: z.input<typeof mcpValueBoundarySchema>
	) =>
		options.send({
			jsonrpc: "2.0",
			method,
			params: mcpValueBoundarySchema.parse(params),
		});
	function hostContext(globals: z.infer<typeof globalsSchema>) {
		const context = {
			theme: globals.theme,
			locale: globals.locale,
			displayMode: globals.displayMode,
			availableDisplayModes:
				options.granted.has("ui.displayMode") &&
				options.services().requestDisplayMode
					? ["inline", "fullscreen", "pip"]
					: ["inline"],
			"openai/deepLink": globals.deepLink ?? { url: "/" },
			"openai/modelContext":
				globals.modelContext ?? options.services().getModelContext?.() ?? null,
		};
		return globals.openedFile
			? { ...context, "openai/file": globals.openedFile }
			: context;
	}
	async function receive(
		input: z.input<typeof mcpEnvelopeBoundarySchema>
	): Promise<boolean> {
		const value = mcpEnvelopeBoundarySchema.parse(input);
		if (value === null) {
			return false;
		}
		const parsedId = mcpIdSchema.safeParse(value.id);
		if (!parsedId.success) {
			return true;
		}
		const id = parsedId.data;
		const params = mcpParamsBoundarySchema.parse(value.params);

		if (value.method === "ui/notifications/initialized") {
			if (!initializeComplete) {
				return true;
			}
			initialized = true;
			const globals = globalsSchema.parse(
				await options.services().getGlobals?.()
			);
			if ("toolInput" in globals) {
				notify("ui/notifications/tool-input", {
					arguments: globals.toolInput,
				});
			}
			if ("toolOutput" in globals) {
				notify("ui/notifications/tool-result", toolResult(globals.toolOutput));
			}
			return true;
		}
		if (value.method === "ui/notifications/size-changed") {
			await dispatchRpc(
				"ui.notifyHeight",
				[params.height],
				options.granted,
				options.services()
			).catch(() => undefined);
			return true;
		}
		if (id === undefined) {
			return true;
		}
		if (inFlight >= 32) {
			options.send({
				jsonrpc: "2.0",
				id,
				error: { code: -32_000, message: "Too many pending app requests" },
			});
			return true;
		}
		inFlight += 1;
		try {
			let result: McpValue;
			if (value.method === "ui/initialize") {
				const context = globalsSchema.parse(
					await options.services().getGlobals?.()
				);
				const contextEnabled =
					options.granted.has("assistant.context") &&
					Boolean(options.services().updateModelContext);
				const hostCapabilities: McpHostCapabilities = { experimental: {} };
				const resourceEnabled =
					options.granted.has("file.access") &&
					Boolean(options.services().readOpenedFile);
				if (resourceEnabled) {
					hostCapabilities.serverResources = { subscribe: true };
					hostCapabilities.experimental["openai/resource"] = {};
				}
				if (options.granted.has("tool.call") && options.services().callTool) {
					hostCapabilities.serverTools = {};
				}
				if (
					options.granted.has("ui.sendMessage") &&
					options.services().sendFollowUpMessage
				) {
					hostCapabilities.message = { text: {} };
				}
				if (contextEnabled) {
					hostCapabilities.updateModelContext = {
						text: {},
						image: {},
						resourceLink: {},
						resource: {},
						structuredContent: {},
					};
					hostCapabilities.experimental["openai/modelContext"] = {};
				}
				const version = z.string().safeParse(params.protocolVersion);
				result = mcpValueBoundarySchema.parse({
					protocolVersion: version.success ? version.data : "2026-01-26",
					hostInfo: { name: "Ryu", version: "1.0.0" },
					hostCapabilities,
					hostContext: hostContext(context),
				});
				initializeComplete = true;
			} else {
				if (!initialized) {
					throw new Error(
						"Call ui/initialize and ui/notifications/initialized first"
					);
				}
				switch (value.method) {
					case "resources/read": {
						const snapshot = await dispatchRpc(
							"files.read",
							[{ uri: params.uri }],
							options.granted,
							options.services()
						);
						const parsedSnapshot = openedFileSnapshotSchema.safeParse(snapshot);
						if (!parsedSnapshot.success) {
							throw new Error("Opened file returned an invalid snapshot");
						}
						const requested = resourceMetaSchema.parse(params._meta)?.[
							"openai/resource"
						]?.representation;
						const representation =
							resourceRepresentationSchema.safeParse(requested);
						if (!representation.success) {
							throw new Error("Resource representation must be text or blob");
						}
						result = {
							contents: [
								{
									uri: z.string().parse(params.uri),
									...resourceRepresentation(
										parsedSnapshot.data,
										representation.data
									),
									_meta: {
										"openai/resource": {
											etag: parsedSnapshot.data.revision,
											writable: Boolean(options.services().writeOpenedFile),
										},
									},
								},
							],
						};
						break;
					}
					case "resources/subscribe":
					case "resources/unsubscribe": {
						await dispatchRpc(
							"files.read",
							[{ uri: params.uri }],
							options.granted,
							options.services()
						);
						const uri = z.string().safeParse(params.uri);
						if (!uri.success) {
							throw new Error("Resource URI is required");
						}
						if (value.method === "resources/subscribe") {
							subscribedResources.add(uri.data);
						} else {
							subscribedResources.delete(uri.data);
						}
						result = {};
						break;
					}
					case "openai/resources/write": {
						const text = z.string().safeParse(params.text);
						const blob = z.string().safeParse(params.blob);
						if (text.success === blob.success) {
							throw new Error(
								"A resource write requires exactly one text or blob payload"
							);
						}
						const payload = text.success
							? { text: text.data }
							: { blob: blob.success ? blob.data : "" };
						const byteLength =
							"text" in payload
								? new TextEncoder().encode(payload.text).length
								: Math.floor((payload.blob.length * 3) / 4) -
									(payload.blob.endsWith("==")
										? 2
										: payload.blob.endsWith("=")
											? 1
											: 0);
						if (byteLength > 2_000_000) {
							result = { outcome: "too-large", maxBytes: 2_000_000 };
							break;
						}
						const current = await dispatchRpc(
							"files.read",
							[{ uri: params.uri }],
							options.granted,
							options.services()
						);
						const currentRevision = revisionSchema.safeParse(current);
						if (!currentRevision.success) {
							throw new Error("Invalid resource revision");
						}
						if (
							params.ifMatch !== undefined &&
							params.ifMatch !== currentRevision.data.revision
						) {
							result = {
								outcome: "conflict",
								etag: currentRevision.data.revision,
							};
							break;
						}
						const saved = await dispatchRpc(
							"files.write",
							[
								{
									uri: params.uri,
									...payload,
									expectedRevision: currentRevision.data.revision,
								},
							],
							options.granted,
							options.services()
						);
						const savedRevision = revisionSchema.safeParse(saved);
						result = {
							outcome: "saved",
							etag: savedRevision.success ? savedRevision.data.revision : null,
						};
						const uri = z.string().safeParse(params.uri);
						if (uri.success && subscribedResources.has(uri.data)) {
							notify("notifications/resources/updated", { uri: uri.data });
						}
						break;
					}
					case "ui/update-model-context": {
						const state = await dispatchRpc(
							"ui.updateModelContext",
							[params],
							options.granted,
							options.services()
						);
						const update = updateIdSchema.safeParse(state);
						result = {
							_meta: {
								"openai/modelContext": {
									updateId: update.success ? update.data.updateId : null,
								},
							},
						};
						notify("ui/notifications/host-context-changed", {
							"openai/modelContext": state,
						});
						break;
					}
					case "tools/call":
						result = toolResult(
							await dispatchRpc(
								"tool.call",
								[params.name, params.arguments ?? {}],
								options.granted,
								options.services()
							)
						);
						break;
					case "ui/request-display-mode":
						result = mcpValueBoundarySchema.parse(
							await dispatchRpc(
								"ui.requestDisplayMode",
								[params],
								options.granted,
								options.services()
							)
						);
						break;
					case "ui/close":
						result = mcpValueBoundarySchema.parse(
							await dispatchRpc(
								"ui.requestClose",
								[],
								options.granted,
								options.services()
							)
						);
						break;
					case "ui/open-link":
						result = mcpValueBoundarySchema.parse(
							await dispatchRpc(
								"ui.openExternal",
								[{ href: params.url }],
								options.granted,
								options.services()
							)
						);
						break;
					case "ui/message": {
						if (params.role !== undefined && params.role !== "user") {
							throw new Error("Only user messages are supported");
						}
						const messageOptions = messageMetaSchema.parse(params._meta)?.[
							"openai/message"
						];
						if (
							messageOptions &&
							"target" in messageOptions &&
							messageOptions.target !== "active"
						) {
							throw new Error(
								"This app is bound to the active conversation; new-conversation messages are unavailable"
							);
						}
						const content = textContentSchema.safeParse(params.content);
						if (!content.success) {
							throw new Error("Only text messages are supported");
						}
						result = mcpValueBoundarySchema.parse(
							await dispatchRpc(
								"ui.sendMessage",
								[
									{
										prompt: content.data.map((item) => item.text).join("\n"),
									},
								],
								options.granted,
								options.services()
							)
						);
						break;
					}
					default:
						options.send({
							jsonrpc: "2.0",
							id,
							error: {
								code: -32_601,
								message: `Unsupported app method: ${value.method}`,
							},
						});
						return true;
				}
			}
			options.send({
				jsonrpc: "2.0",
				id,
				result: mcpValueBoundarySchema.parse(result ?? {}),
			});
		} catch (error) {
			options.send({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32_602,
					message:
						error instanceof Error ? error.message : "App request failed",
				},
			});
		} finally {
			inFlight -= 1;
		}
		return true;
	}
	return {
		receive,
		push(globals: WidgetGlobalsPatch) {
			if (!initialized) {
				return;
			}
			notify(
				"ui/notifications/host-context-changed",
				hostContext(globalsSchema.parse(globals))
			);
			if (globals.toolInput !== undefined) {
				notify("ui/notifications/tool-input", { arguments: globals.toolInput });
			}
			if (globals.toolOutput !== undefined) {
				notify("ui/notifications/tool-result", toolResult(globals.toolOutput));
			}
			if (
				globals.openedFile &&
				subscribedResources.has(globals.openedFile.uri)
			) {
				notify("notifications/resources/updated", {
					uri: globals.openedFile.uri,
				});
			}
		},
	};
}

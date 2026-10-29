import type { AppWidget } from "@ryu/blocks/desktop/agent-elements/app-widget.tsx";
import type { ComponentProps } from "react";
import { z } from "zod";
import { type ApiTarget, authenticatedFetch } from "./client.ts";
import type { GatewayJsonValue } from "./gateway-json-contracts.ts";

export const mcpAppPartSchema = z.object({
	type: z.literal("data-tool-widget-available"),
	data: z.object({
		conversationId: z.string().min(1).nullish(),
		toolCallId: z.string().min(1),
		toolName: z.string().min(1),
		instanceId: z.string().min(1),
		serverId: z.string().min(1),
		templateUri: z.string().optional(),
		toolInput: z.unknown(),
		toolOutput: z.unknown(),
		toolResponseMetadata: z.unknown(),
		widgetAccessible: z.boolean(),
		approvedGrants: z.array(z.string()).optional(),
		initialWidgetState: z.unknown().optional(),
		displayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
		widget: z.object({
			html: z.string().max(4 * 1024 * 1024),
			mimeType: z.string(),
			csp: z
				.object({ resource_domains: z.array(z.string()).optional() })
				.optional(),
		}),
	}),
});

export type McpAppPart = ComponentProps<typeof AppWidget>["part"];

export async function openMcpApp(
	target: ApiTarget,
	input: {
		toolId: string;
		idempotencyKey: string;
		agentId: string;
		conversationId?: string;
		arguments?: Record<string, GatewayJsonValue>;
	},
	options?: {
		onPending?: (conversationId?: string) => void;
		signal?: AbortSignal;
	}
): Promise<McpAppPart> {
	const requestBody = JSON.stringify(input);
	while (true) {
		if (options?.signal?.aborted) {
			throw new DOMException("App activation canceled", "AbortError");
		}
		const response = await authenticatedFetch(target, "/api/widgets/open", {
			method: "POST",
			body: requestBody,
			signal: options?.signal,
		});
		if (response.status === 202) {
			const pending = z
				.object({
					status: z.literal("pending"),
					idempotencyKey: z.string().min(1),
					conversationId: z.string().min(1).optional(),
				})
				.parse(await response.json());
			if (pending.idempotencyKey !== input.idempotencyKey) {
				throw new Error("App activation returned an unexpected operation key");
			}
			if (
				input.conversationId &&
				pending.conversationId &&
				pending.conversationId !== input.conversationId
			) {
				throw new Error("App activation returned an unexpected conversation");
			}
			if (options?.signal?.aborted) {
				throw new DOMException("App activation canceled", "AbortError");
			}
			options?.onPending?.(pending.conversationId);
			await new Promise<void>((resolve, reject) => {
				const signal = options?.signal;
				if (signal?.aborted) {
					reject(new DOMException("App activation canceled", "AbortError"));
					return;
				}
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				}, 1000);
				function abort() {
					clearTimeout(timer);
					reject(new DOMException("App activation canceled", "AbortError"));
				}
				signal?.addEventListener("abort", abort, { once: true });
			});
			continue;
		}
		if (!response.ok) {
			const parsed = z
				.object({ error: z.string() })
				.safeParse(await response.json().catch(() => null));
			const message = parsed.success
				? parsed.data.error
				: `Could not open app (${response.status})`;
			throw new Error(message);
		}
		const part = mcpAppPartSchema.parse(await response.json());
		if (
			input.conversationId &&
			part.data.conversationId &&
			part.data.conversationId !== input.conversationId
		) {
			throw new Error("App activation returned an unexpected conversation");
		}
		return part;
	}
}

import type { UIMessage } from "ai";
import { z } from "zod";
import { type AssistantDocReference, resolveDocHref } from "./docs.ts";
import {
	type LocalNodeConfig,
	type LocalNodeHealth,
	normalizeNodeUrl,
} from "./local-node.ts";

export interface AssistantMessage {
	id: string;
	references?: AssistantDocReference[];
	role: "assistant" | "user";
	text: string;
}

export interface ActiveRequest {
	assistantId: string;
	controller: AbortController;
	id: string;
}

export const NODE_SESSION_KEY = "ryu-assistant-node-v1";

const storedNodeSchema = z.object({
	baseUrl: z.string().transform(normalizeNodeUrl),
	token: z.string().nullable().catch(null),
});
export function readStoredNode(): z.infer<typeof storedNodeSchema> | null {
	try {
		const raw = sessionStorage.getItem(NODE_SESSION_KEY);
		if (!raw) {
			return null;
		}
		const decoded = storedNodeSchema.safeParse(JSON.parse(raw));
		return decoded.success ? decoded.data : null;
	} catch {
		return null;
	}
}

export function storeNode(config: LocalNodeConfig): void {
	try {
		sessionStorage.setItem(NODE_SESSION_KEY, JSON.stringify(config));
	} catch {
		// Private browsing can deny session storage; in-memory use still works.
	}
}

export function clearStoredNode(): void {
	try {
		sessionStorage.removeItem(NODE_SESSION_KEY);
	} catch {
		// Nothing to clear when storage is unavailable.
	}
}

export function nodeSummary(health: LocalNodeHealth): string {
	const version = health.version ? `Core ${health.version}` : "Core online";
	return health.channel ? `${version} · ${health.channel}` : version;
}

export function messageId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toChatMessage(
	message: AssistantMessage,
	docsBaseUrl: string | undefined,
	isBusy: boolean
): UIMessage {
	const text =
		message.text ||
		(isBusy && message.role === "assistant" ? "Thinking locally…" : "");
	const sourceLinks = message.references?.length
		? message.references
				.map(
					(reference) =>
						`[${reference.title}](${resolveDocHref(docsBaseUrl, reference.href)})`
				)
				.join(" · ")
		: "";
	const content = sourceLinks ? `${text}\n\nSources: ${sourceLinks}` : text;

	return {
		id: message.id,
		parts: [{ text: content, type: "text" }],
		role: message.role,
	};
}

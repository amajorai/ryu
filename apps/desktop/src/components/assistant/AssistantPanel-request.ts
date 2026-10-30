import type { UIMessage } from "ai";
import type { BuilderBodyFields } from "@/src/hooks/useBuilderRuntime.ts";
import type {
	AssistantBuilderSession,
	PageContextItem,
} from "@/src/store/useAssistantStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { buildBuilderPreamble, injectPreamble } from "./builderPreamble.ts";

/** Builder panes describe what to build rather than chat. */
export const BUILDER_PLACEHOLDER = "Describe what to build…";

/** Persisted default-agent key, shared with the home chat composer so picking an
 *  agent in either place keeps them in sync. */
export const DEFAULT_AGENT_KEY = "ryu_default_agent";
/** The driving-agent key for builder mode — remembered independently of the
 *  generic assistant agent and defaulting to the flagship `ryu`. */
export const BUILDER_AGENT_KEY = "ryu_assistant_builder_agent";

/** Human label for the generic "current page" context derived from the tab. */
export function tabContextTitle(title: string, path: string): string {
	const clean = title?.trim();
	if (clean && clean !== "New chat") {
		return clean;
	}
	// Fall back to a readable name from the path (e.g. "/spaces" → "Spaces").
	const seg = path.split("?")[0].split("/").filter(Boolean)[0] ?? "page";
	return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Resolve the published context to plain text at SEND time.
 *
 * An item's `getText` wins over its `text` snapshot — that is the whole point of
 * the lazy form: a dashboard's widgets refresh on their own, so the snapshot the
 * page pushed when it mounted describes a board that no longer exists. A
 * resolver that throws degrades to its snapshot rather than failing the send.
 */
export async function resolveContext(
	context: PageContextItem[]
): Promise<{ source?: string; text: string; title: string }[]> {
	return await Promise.all(
		context.map(async (c) => {
			const head = { title: c.title, source: c.source };
			if (!c.getText) {
				return { ...head, text: c.text };
			}
			try {
				return { ...head, text: (await c.getText()) || c.text };
			} catch {
				return { ...head, text: c.text };
			}
		})
	);
}

/** The `<page-context>` block for a resolved context set, or "" when empty. */
export function contextBlock(
	resolved: { source?: string; text: string; title: string }[]
): string {
	if (resolved.length === 0) {
		return "";
	}
	return resolved
		.map((c) => {
			// Attribution rides into the prompt too: the model should know a claim
			// came from an app, not from the user or from Ryu itself.
			const head = c.source
				? `### ${c.title} (from ${c.source})`
				: `### ${c.title}`;
			const body = c.text.trim();
			return body ? `${head}\n${body}` : head;
		})
		.join("\n\n");
}

/**
 * Build the chat-stream request body for one turn. In builder mode it injects the
 * builder preamble + drives the `*_builder.*` tools with `persist: false`; in
 * generic mode it carries the workspace cwd and persists normally. Top-level so
 * the transport closure — and the panel — stay lean.
 */
export function buildChatRequestBody(params: {
	builderBodyFields: () => BuilderBodyFields;
	convId: string;
	genericBodyFields: () => BuilderBodyFields;
	outgoing: UIMessage[];
	session: AssistantBuilderSession | null;
	/** The session's chat id — an app surface's per-thread id. */
	sessionConvId: string;
	targetId: string | null;
}) {
	const { outgoing, session, targetId } = params;
	if (session) {
		const id = targetId ?? session.targetId;
		const messages = id
			? injectPreamble(
					outgoing,
					buildBuilderPreamble(session, id, session.snapshot)
				)
			: outgoing;
		return {
			body: {
				messages,
				...params.builderBodyFields(),
				conversation_id: params.sessionConvId,
				persist: false,
				enable_long_term: false,
			},
		};
	}
	// Page context is folded into the message text in `handleSend`, not a preamble.
	const cwd = useWorkspaceStore.getState().folder ?? undefined;
	return {
		body: {
			messages: outgoing,
			...params.genericBodyFields(),
			conversation_id: params.convId,
			cwd,
			enable_long_term: false,
		},
	};
}

/** Copy under the empty-state title. An app-defined surface supplies its own;
 *  the two built-in builders keep their curated wording. */
export function surfaceDescription(session: AssistantBuilderSession): string {
	if (session.description) {
		return session.description;
	}
	if (session.kind === "agent") {
		return "Ask what this agent should be. When it tries to change itself, I'll ask you to allow or deny the tool call.";
	}
	if (session.kind === "workflow") {
		return "Describe what the workflow should do in plain language. I'll assemble the nodes and wiring on the canvas.";
	}
	return "Ask about what you have open here, or say what you want changed.";
}

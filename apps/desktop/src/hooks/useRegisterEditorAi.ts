import { setEditorAiConfig } from "@ryu/ui/lib/editor-ai";
import { useEffect } from "react";
import { getPreference } from "@/src/lib/api/preferences.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Core preferences key holding the editor-AI config blob. */
export const EDITOR_AI_PREF_KEY = "editor-ai";

/** Persisted shape of the editor-AI preference. */
export interface EditorAiPref {
	/**
	 * Optional id of the agent backing the editor AI. When set, the settings UI
	 * resolves the agent's model into `model` at save time, and the id is
	 * forwarded to the Gateway for per-agent routing / audit.
	 */
	agentId?: string;
	/** Optional override; blank → derived from the node's Gateway port. */
	baseUrl?: string;
	enabled: boolean;
	model: string;
}

/** The Gateway's OpenAI-compatible base for a given Core node URL (port 7981). */
export function deriveGatewayBase(nodeUrl: string): string {
	try {
		const u = new URL(nodeUrl);
		u.port = "7981";
		return `${u.origin}/v1`;
	} catch {
		return "http://127.0.0.1:7981/v1";
	}
}

/**
 * Loads the saved editor-AI preference for the active node and registers it with
 * `@ryu/ui` so the Plate editor's inline AI routes through the Gateway. When
 * unset/disabled, the editor falls back to its built-in mock stream.
 */
export function useRegisterEditorAi(): void {
	const node = useActiveNode();

	useEffect(() => {
		let cancelled = false;
		getPreference(
			{ url: node.url, token: node.token ?? null },
			EDITOR_AI_PREF_KEY
		)
			.then((raw) => {
				if (cancelled) {
					return;
				}
				if (!raw) {
					setEditorAiConfig({ enabled: false });
					return;
				}
				try {
					const pref = JSON.parse(raw) as EditorAiPref;
					setEditorAiConfig({
						enabled: pref.enabled && pref.model.trim().length > 0,
						model: pref.model,
						baseUrl: pref.baseUrl?.trim()
							? pref.baseUrl
							: deriveGatewayBase(node.url),
						apiKey: node.token ?? undefined,
						agentId: pref.agentId?.trim() ? pref.agentId : undefined,
					});
				} catch {
					setEditorAiConfig({ enabled: false });
				}
			})
			.catch(() => {
				if (!cancelled) {
					setEditorAiConfig({ enabled: false });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [node.url, node.token]);
}

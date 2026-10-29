import { setEditorAiConfig } from "@ryu/ui/lib/editor-ai.ts";
import { useEffect } from "react";
import { z } from "zod";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getLaneAgentSelection,
	getPreference,
} from "@/src/lib/api/preferences.ts";
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

/** Core's release port, and the base every profile offset is measured from. */
const CORE_RELEASE_PORT = 7980;

/**
 * The Gateway's OpenAI-compatible base for a given Core node URL.
 *
 * DERIVED FROM THE NODE'S OWN PORT, never a literal. This pinned `7981` in both
 * branches, which is correct only on the release profile: `RYU_PROFILE` offsets
 * every port by a multiple of 1000, so a dev Core on 8980 has its Gateway on
 * 8981, canary 9980/9981, nightly 10980/10981. Editor AI was therefore
 * release-correct and dead everywhere else — the Cmd+J menu and the copilot ghost
 * text both dialling a port nothing was listening on. That is almost certainly
 * why "the editor AI is broken" was believable enough to reach a blocker register
 * as a missing-route bug.
 *
 * The relationship that actually holds, and the one Core and the Gateway both
 * encode (`apps/core/src/profile.rs` `port(7980)`, `apps/gateway/src/profile.rs`
 * `port(7981)`): **the Gateway is Core's port plus one, on every profile.** So
 * the offset never has to be known here — the node URL already carries it.
 *
 * Falls back to the release pair only when the URL has no usable port to derive
 * from, which is the one case where there is nothing to infer.
 */
export function deriveGatewayBase(nodeUrl: string): string {
	try {
		const u = new URL(nodeUrl);
		// An empty `u.port` means the URL used the scheme default (80/443), i.e. a
		// hosted node behind a proxy rather than a local Core — there is no Core
		// port to add one to, so the release pair is the only sane guess.
		const corePort = Number.parseInt(u.port, 10);
		u.port = String(
			Number.isFinite(corePort) && corePort > 0
				? corePort + 1
				: CORE_RELEASE_PORT + 1
		);
		return `${u.origin}/v1`;
	} catch {
		return `http://127.0.0.1:${CORE_RELEASE_PORT + 1}/v1`;
	}
}

/** What the editor AI should run as when nothing has been configured for it. */
interface ResolvedEditorAgent {
	agentId?: string;
	model: string;
}

/**
 * Resolve the node-wide default agent into a concrete {agentId, model}.
 *
 * This is the SAME inheritance every other unset agent/model setting follows
 * (the local lane, edited in the Gateway dialog): a feature that was
 * never configured runs as the node's default rather than not running. Returns a
 * blank model when the node genuinely has nothing usable, which is the only case
 * that should still surface "not configured".
 */
async function resolveDefaultAgent(
	target: ApiTarget
): Promise<ResolvedEditorAgent> {
	const selection = await getLaneAgentSelection(target, "local");
	// A selection may name an agent, a bare model, or both. A named model wins —
	// it is the more specific of the two and needs no lookup.
	const agentId = selection.agent_id.trim() || undefined;
	if (selection.model.trim()) {
		return { agentId, model: selection.model.trim() };
	}
	if (!agentId) {
		return { model: "" };
	}
	const agents = await fetchAgents(target).catch(() => []);
	const agent = agents.find((a) => a.id === agentId);
	return { agentId, model: agent?.model?.trim() ?? "" };
}

/**
 * Loads the saved editor-AI preference for the active node and registers it with
 * `@ryu/ui` so the Plate editor's inline AI routes through the Gateway.
 *
 * When the preference is absent — which is the normal state, since nothing in the
 * product ever asks the user to configure this — the editor inherits the NODE-WIDE
 * DEFAULT AGENT instead of switching itself off. Failing closed there is what
 * produced "Editor AI is not configured. Turn it on in Settings → Editor and pick
 * a model." on a node that had a perfectly good default agent the whole time, and
 * pointed at a settings surface most users will never have opened.
 *
 * An explicit preference still wins in both directions: a user who turned the
 * feature OFF stays off, and a user who picked a model gets that model.
 */
export function useRegisterEditorAi(): void {
	const node = useActiveNode();

	useEffect(() => {
		let cancelled = false;
		const target: ApiTarget = {
			url: node.url,
			token: node.token,
			userJwt: node.userJwt ?? null,
		};

		const register = async () => {
			const raw = await getPreference(target, EDITOR_AI_PREF_KEY).catch(
				() => null
			);

			// An explicit preference: honour it exactly, including an explicit "off".
			if (raw) {
				try {
					const pref = z
						.object({
							agentId: z.string().optional(),
							baseUrl: z.string().optional(),
							enabled: z.boolean(),
							model: z.string(),
						})
						.parse(JSON.parse(raw));
					if (cancelled) {
						return;
					}
					setEditorAiConfig({
						enabled: pref.enabled && pref.model.trim().length > 0,
						model: pref.model,
						baseUrl: pref.baseUrl?.trim()
							? pref.baseUrl
							: deriveGatewayBase(node.url),
						apiKey: node.token ?? undefined,
						agentId: pref.agentId?.trim() ? pref.agentId : undefined,
					});
					return;
				} catch {
					// Corrupt blob — fall through to the default agent rather than
					// leaving the editor dead because one preference failed to parse.
				}
			}

			const fallback: ResolvedEditorAgent = await resolveDefaultAgent(
				target
			).catch(() => ({
				agentId: undefined,
				model: "",
			}));
			if (cancelled) {
				return;
			}
			setEditorAiConfig({
				enabled: fallback.model.length > 0,
				model: fallback.model,
				baseUrl: deriveGatewayBase(node.url),
				apiKey: node.token ?? undefined,
				agentId: fallback.agentId,
			});
		};

		register().catch(() => {
			if (!cancelled) {
				setEditorAiConfig({ enabled: false });
			}
		});

		return () => {
			cancelled = true;
		};
	}, [node.url, node.token]);
}

import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { hasPluginChatFeature } from "@/src/lib/plugin-chat-features.ts";
import {
	RECONNECT_RETRY_FEATURE_KIND,
	RECONNECT_RETRY_PLUGIN_ID,
} from "@/src/lib/reconnect-retry.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	type ReconnectRetryState,
	useReconnectRetryRecovery,
} from "./useReconnectRetryRecovery.ts";
import { useRuns } from "./useRuns.ts";

export type {
	ReconnectRetryPhase,
	ReconnectRetryState,
} from "./useReconnectRetryRecovery.ts";

/**
 * Own the desktop half of the opt-in reconnect-retry feature. The hook is
 * mounted once by Layout, so it can observe all background runs rather than only
 * the focused ChatPage.
 */
export function useReconnectRetry(): ReconnectRetryState {
	const activeNode = useActiveNode();
	const { runs } = useRuns();
	const { chat_features: chatFeatures } = usePluginContributions();
	const pluginEnabled = hasPluginChatFeature(
		chatFeatures,
		RECONNECT_RETRY_PLUGIN_ID,
		RECONNECT_RETRY_FEATURE_KIND
	);
	const activeNodeOnline = useNodeStore((state) => state.activeNodeOnline);
	const probeActiveNode = useNodeStore((state) => state.probeActiveNode);
	return useReconnectRetryRecovery({
		activeNode,
		activeNodeOnline,
		devRecovery: Boolean(import.meta.env.DEV),
		pluginEnabled,
		probeActiveNode,
		runs,
	});
}

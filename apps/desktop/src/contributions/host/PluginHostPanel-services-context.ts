import type { OpenedFileAccess } from "@ryu/app-host/opened-file";
import type { createScopedToastHost } from "@ryu/app-host/toast-host";
import type { useI18n } from "@ryu/i18n/react";
import type { RealtimeConnection } from "@ryuhq/core-client/realtime.ts";
import type { ContextType, RefObject } from "react";
import type { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import type { TabsContext } from "@/src/contexts/TabsContext.tsx";
import type { ApplicationRealtimeQueue } from "@/src/contributions/host/application-realtime-queue.ts";
import type {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import type { PluginCompanion } from "@/src/lib/api/plugins.ts";
import type {
	AssistantBuilderSession,
	PageContextItem,
} from "@/src/store/useAssistantStore.ts";
import type { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

export interface ApplicationRealtimeSession {
	connection: RealtimeConnection;
	queue: ApplicationRealtimeQueue;
}

type TabsContextValue = NonNullable<ContextType<typeof TabsContext>>;

/** Everything the `PluginHostPanel` host-service builders close over. */
export interface PluginHostServicesContext {
	approvedGrantList: string[];
	assistantContextRef: RefObject<PageContextItem[]>;
	assistantOwner: string;
	assistantSurfaceRef: RefObject<AssistantBuilderSession | null>;
	companion: PluginCompanion;
	currentTabId: string | undefined;
	distributeInstalledSkill: ReturnType<
		typeof useSkillDistributionFlow
	>["distributeInstalledSkill"];
	fileAccess: OpenedFileAccess | undefined;
	getActiveNode: ReturnType<typeof useActiveNodeGetter>;
	i18n: ReturnType<typeof useI18n>;
	isActiveTabRef: RefObject<boolean>;
	mediaPermission: string | undefined;
	meId: string | null;
	node: ReturnType<typeof useActiveNode>;
	onRequestClose: (() => void) | undefined;
	openGateway: ReturnType<typeof useGatewayDialog.getState>["openGateway"];
	openTab: TabsContextValue["openTab"];
	realtimeLifetimeRef: RefObject<AbortController | null>;
	realtimeSessionsRef: RefObject<Map<string, ApplicationRealtimeSession>>;
	toastHost: ReturnType<typeof createScopedToastHost>;
	updateTabsIconWhere: TabsContextValue["updateTabsIconWhere"];
	updateTabTitle: TabsContextValue["updateTabTitle"];
}

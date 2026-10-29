import type { Tab } from "@/src/contexts/TabsContext.tsx";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import {
	snapshotTab,
	type TabTransfer,
	TabTransferBlockedError,
} from "@/src/lib/tab-transfer.ts";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import { conversationEntityKey } from "@/src/lib/window-routing.ts";
import { useArtifactStore } from "@/src/store/useArtifactStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Outbound live store carriage reaches the unchanged native serializer.
 * This does not claim a parsed recipient Artifact or widen its wire contract. */
type OutboundTabTransfer = Omit<TabTransfer, "artifact"> & {
	artifact?: ArtifactView;
};

/** Resolves true only after the new renderer has mounted the transferred tab.
 * A failed/cancelled drag or window creation leaves the source untouched. */
export async function moveTabToWindow(
	tab: Tab,
	dragOut = false
): Promise<boolean> {
	const transfer: OutboundTabTransfer = {
		version: 1,
		tab: snapshotTab(tab),
		node: useNodeStore.getState().getActiveNode(tab.id).name,
		artifact: tab.path.startsWith("/artifact/")
			? useArtifactStore.getState().get(tab.path.slice("/artifact/".length))
			: undefined,
	};
	const snapshot = JSON.stringify(transfer.tab);
	const moved = await invokeWhenReady<boolean>("open_tab_window", {
		path: tab.path,
		conversationId: tab.conversationId ?? null,
		entityKey: tab.conversationId
			? conversationEntityKey(tab.conversationId)
			: null,
		node: transfer.node ?? null,
		title: tab.title,
		transfer,
		dragOut,
	});
	if (moved && JSON.stringify(snapshotTab(tab)) !== snapshot) {
		throw new TabTransferBlockedError(
			"This tab changed while its new window was opening. Your latest edits are still in the original window."
		);
	}
	return moved;
}

import { useCallback, useState } from "react";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import type { TerminalCommandRequest } from "@/src/store/useDockPanelRequestStore.ts";
import { makeTab, type PanelTab, type TabKind } from "./tab-model.ts";

export function usePanelTabs(initial: PanelTab[]) {
	const [tabs, setTabs] = useState<PanelTab[]>(initial);
	const [activeUid, setActiveUid] = useState(initial[0]?.uid ?? "");

	const addTab = (kind: TabKind, label: string) => {
		const sameKind = tabs.filter((t) => t.kind === kind);
		const tab = makeTab(kind, label, sameKind.length + 1);
		setTabs((prev) => [...prev, tab]);
		setActiveUid(tab.uid);
		return tab.uid;
	};

	/** Open one ARTIFACT per tab: focus the existing tab showing the same artifact
	 *  id, or stack a new one. This is what lets several artifacts sit side by
	 *  side in the dock (no one-at-a-time limit) while re-opening one re-focuses. */
	const openArtifact = (artifact: ArtifactView) => {
		const existing = tabs.find(
			(t) => t.kind === "artifact" && t.artifact?.id === artifact.id
		);
		if (existing) {
			setTabs((prev) =>
				prev.map((t) => (t.uid === existing.uid ? { ...t, artifact } : t))
			);
			setActiveUid(existing.uid);
			return existing.uid;
		}
		const tab = makeTab("artifact", artifact.title, undefined, artifact);
		setTabs((prev) => [...prev, tab]);
		setActiveUid(tab.uid);
		return tab.uid;
	};

	const closeTab = (uid: string) => {
		setTabs((prev) => {
			const next = prev.filter((t) => t.uid !== uid);
			if (activeUid === uid) {
				setActiveUid(next.at(-1)?.uid ?? "");
			}
			return next;
		});
	};

	// Close every tab except `uid`, and make `uid` active — the window tabs'
	// "Close others" behavior.
	const closeOthers = (uid: string) => {
		setTabs((prev) => prev.filter((t) => t.uid === uid));
		setActiveUid(uid);
	};

	const closeAll = () => {
		setTabs([]);
		setActiveUid("");
	};

	// Append an existing tab (moved in from the other dock) and focus it. The uid
	// comes from the shared module counter so it stays unique across docks.
	const adoptTab = (tab: PanelTab) => {
		setTabs((prev) => [...prev, tab]);
		setActiveUid(tab.uid);
	};

	// Open a single reusable tab of a kind: focus the existing one (updating its
	// label) or create it. Used to surface a clicked subagent's transcript without
	// stacking a new tab per click.
	const openTab = useCallback(
		(
			kind: TabKind,
			label: string,
			initialCommand?: TerminalCommandRequest,
			initialCommandNonce?: number
		) => {
			const existing = tabs.find((t) => t.kind === kind);
			if (existing) {
				setTabs((prev) =>
					prev.map((t) =>
						t.uid === existing.uid
							? {
									...t,
									label,
									initialCommand,
									initialCommandNonce,
								}
							: t
					)
				);
				setActiveUid(existing.uid);
				return;
			}
			const tab = makeTab(
				kind,
				label,
				undefined,
				undefined,
				undefined,
				initialCommand,
				initialCommandNonce
			);
			setTabs((prev) => [...prev, tab]);
			setActiveUid(tab.uid);
		},
		[tabs]
	);

	return {
		tabs,
		activeUid,
		setActiveUid,
		addTab,
		closeTab,
		closeOthers,
		closeAll,
		adoptTab,
		openArtifact,
		openTab,
	};
}

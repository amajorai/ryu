import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	ComputerTerminal01Icon,
	File01Icon,
	FileCodeIcon,
	FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import type { ComponentProps } from "react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PanelTabBar } from "../../src/components/panels/WorkspacePanels.tsx";
import type { PanelTabBarProofSnapshot } from "../panel-tab-bar-proof.contracts.ts";
import styles from "./panel-tab-bar-proof.module.css";
import "../../src/index.css";

type PanelTabBarProofProps = ComponentProps<typeof PanelTabBar>;
type ProofTab = PanelTabBarProofProps["tabs"][number];
type ProofTabType = PanelTabBarProofProps["addTypes"][number];

const BOTTOM_ADD_TYPES: ProofTabType[] = [
	{ icon: ComputerTerminal01Icon, kind: "terminal", label: "Terminal" },
	{ icon: FileCodeIcon, kind: "codereview", label: "Changes" },
];

const RIGHT_ADD_TYPES: ProofTabType[] = [
	...BOTTOM_ADD_TYPES,
	{ icon: FolderOpenIcon, kind: "files", label: "Files" },
	{ kind: "context", label: "Context" },
];

const PAGE_TYPES: ProofTabType[] = [
	{ icon: File01Icon, kind: "route:/library/space", label: "Spaces" },
	{ icon: File01Icon, kind: "route:/store", label: "Store" },
];

type ProofEvent = PanelTabBarProofSnapshot["events"][number];

function createInitialTabs() {
	const query = new URLSearchParams(window.location.search);
	const pinBlocked = query.get("pinDisabled") === "true";
	if (query.get("nonPinnable") === "true") {
		return {
			bottom: [{ kind: "context", label: "Context", uid: "bottom-context" }],
			right: [{ kind: "context", label: "Context", uid: "right-context" }],
		} satisfies { bottom: ProofTab[]; right: ProofTab[] };
	}
	if (query.get("single") === "true") {
		return {
			bottom: [
				{
					kind: "terminal",
					label: "Terminal",
					uid: "bottom-terminal",
				},
			],
			right: [{ kind: "context", label: "Context", uid: "right-context" }],
		} satisfies { bottom: ProofTab[]; right: ProofTab[] };
	}
	const pinFields: Pick<ProofTab, "pinned"> = {};
	if (pinBlocked) {
		pinFields.pinned = true;
	}
	return {
		bottom: [
			{
				kind: "terminal",
				label: "Terminal",
				uid: "bottom-terminal",
			},
			{
				kind: "files",
				label: "Files",
				...pinFields,
				uid: "bottom-files",
			},
			{
				kind: "codereview",
				label: "Changes",
				uid: "bottom-changes",
			},
		],
		right: [{ kind: "context", label: "Context", uid: "right-context" }],
	} satisfies { bottom: ProofTab[]; right: ProofTab[] };
}

function ProofArtifact() {
	const [initialTabs] = useState(createInitialTabs);
	const [bottomTabs, setBottomTabs] = useState<ProofTab[]>(initialTabs.bottom);
	const [rightTabs, setRightTabs] = useState<ProofTab[]>(initialTabs.right);
	const [bottomActive, setBottomActive] = useState(
		initialTabs.bottom[0]?.uid ?? ""
	);
	const [rightActive, setRightActive] = useState(
		initialTabs.right[0]?.uid ?? ""
	);
	const [events, setEvents] = useState<ProofEvent[]>([]);
	const [closedPanelCount, setClosedPanelCount] = useState({
		bottom: 0,
		right: 0,
	});
	const [nextTabNumber, setNextTabNumber] = useState(1);
	const pinDisabledReason = new URLSearchParams(window.location.search).get(
		"pinDisabled"
	)
		? "Open a project to pin and share tabs across chats"
		: undefined;

	const record = (event: ProofEvent) =>
		setEvents((previous) => [...previous, event]);
	const tabsFor = (side: "bottom" | "right") =>
		side === "bottom" ? bottomTabs : rightTabs;
	const setTabsFor = (side: "bottom" | "right", tabs: ProofTab[]) =>
		side === "bottom" ? setBottomTabs(tabs) : setRightTabs(tabs);
	const setActiveFor = (side: "bottom" | "right", uid: string) =>
		side === "bottom" ? setBottomActive(uid) : setRightActive(uid);
	const activeFor = (side: "bottom" | "right") =>
		side === "bottom" ? bottomActive : rightActive;

	const activate = (side: "bottom" | "right", uid: string) => {
		record({ action: "activate", from: side, uid });
		setActiveFor(side, uid);
	};
	const closeTab = (side: "bottom" | "right", uid: string) => {
		const nextTabs = tabsFor(side).filter((tab) => tab.uid !== uid);
		record({ action: "close-tab", from: side, uid });
		setTabsFor(side, nextTabs);
		if (activeFor(side) === uid) {
			setActiveFor(side, nextTabs.at(-1)?.uid ?? "");
		}
	};
	const closeOthers = (side: "bottom" | "right", uid: string) => {
		record({ action: "close-others", from: side, uid });
		setTabsFor(
			side,
			tabsFor(side).filter((tab) => tab.uid === uid)
		);
		setActiveFor(side, uid);
	};
	const closeAll = (side: "bottom" | "right") => {
		record({ action: "close-all", from: side });
		setTabsFor(side, []);
		setActiveFor(side, "");
	};
	const togglePin = (side: "bottom" | "right", uid: string) => {
		record({ action: "toggle-pin", from: side, uid });
		setTabsFor(
			side,
			tabsFor(side).map((tab) =>
				tab.uid === uid ? { ...tab, pinned: !tab.pinned } : tab
			)
		);
	};
	const moveTab = (from: "bottom" | "right", uid: string) => {
		const to = from === "bottom" ? "right" : "bottom";
		const sourceTabs = tabsFor(from);
		const moved = sourceTabs.find((tab) => tab.uid === uid);
		if (!moved) {
			return;
		}
		const nextSource = sourceTabs.filter((tab) => tab.uid !== uid);
		record({ action: "move-tab", from, to, uid });
		setTabsFor(from, nextSource);
		setTabsFor(to, [...tabsFor(to), moved]);
		if (activeFor(from) === uid) {
			setActiveFor(from, nextSource.at(-1)?.uid ?? "");
		}
		setActiveFor(to, uid);
	};
	const addTab = (side: "bottom" | "right", kind: DockTabKind) => {
		const menuTypes = side === "bottom" ? BOTTOM_ADD_TYPES : RIGHT_ADD_TYPES;
		const definition = [
			...menuTypes,
			...(side === "right" ? PAGE_TYPES : []),
		].find((type) => type.kind === kind);
		if (!definition) {
			return;
		}
		const ordinal = nextTabNumber;
		const uid = `${side}-new-${ordinal}`;
		const label = `${definition.label} ${ordinal}`;
		const nextTab: ProofTab = { kind, label, uid };
		record({ action: "add-tab", from: side, uid, kind, label });
		setNextTabNumber((number) => number + 1);
		setTabsFor(side, [...tabsFor(side), nextTab]);
		setActiveFor(side, uid);
	};
	const closePanel = (side: "bottom" | "right") => {
		record({ action: "close-panel", from: side });
		setClosedPanelCount((counts) => ({ ...counts, [side]: counts[side] + 1 }));
	};

	const iconForKind = (_kind: DockTabKind) => ({
		glyph: ComputerTerminal01Icon,
	});
	const bottomProps: PanelTabBarProofProps = {
		activeUid: bottomActive,
		addTypes: BOTTOM_ADD_TYPES,
		iconForKind,
		onActivate: (uid) => activate("bottom", uid),
		onAdd: (kind) => addTab("bottom", kind),
		onCloseAll: () => closeAll("bottom"),
		onCloseOthers: (uid) => closeOthers("bottom", uid),
		onClosePanel: () => closePanel("bottom"),
		onCloseTab: (uid) => closeTab("bottom", uid),
		onMoveToOtherPanel: (uid) => moveTab("bottom", uid),
		onTogglePin: (uid) => togglePin("bottom", uid),
		otherPanelIcon: ArrowRight01Icon,
		otherPanelLabel: "right panel",
		pinDisabledReason,
		tabs: bottomTabs,
	};
	const rightProps: PanelTabBarProofProps = {
		activeUid: rightActive,
		addTypes: RIGHT_ADD_TYPES,
		iconForKind,
		onActivate: (uid) => activate("right", uid),
		onAdd: (kind) => addTab("right", kind),
		onCloseAll: () => closeAll("right"),
		onCloseOthers: (uid) => closeOthers("right", uid),
		onClosePanel: () => closePanel("right"),
		onCloseTab: (uid) => closeTab("right", uid),
		onMoveToOtherPanel: (uid) => moveTab("right", uid),
		onTogglePin: (uid) => togglePin("right", uid),
		otherPanelIcon: ArrowDown01Icon,
		otherPanelLabel: "bottom panel",
		pageTypes: PAGE_TYPES,
		pinDisabledReason,
		tabs: rightTabs,
	};

	return (
		<TooltipProvider delay={0}>
			<main
				className={`dark min-h-screen space-y-5 px-8 py-8 ${styles.surface}`}
			>
				<header>
					<div className={`text-xs ${styles.kicker}`}>
						RYU · LIVE REACT PROOF
					</div>
					<h1 className="mt-2 font-semibold text-3xl">Workspace panel tabs</h1>
					<p className={`mt-2 text-sm ${styles.caption}`}>
						Both production dock tab bars use local state callbacks; no project,
						filesystem, or native command is invoked.
					</p>
				</header>
				<div className="grid gap-4 xl:grid-cols-2">
					{(
						[
							["bottom", "Bottom dock", bottomProps],
							["right", "Right dock", rightProps],
						] as const
					).map(([side, title, props]) => (
						<section
							className={`min-w-0 overflow-hidden rounded-2xl border ${styles.dock}`}
							data-testid={`${side}-dock`}
							key={side}
						>
							<div className={`border-b px-4 py-3 ${styles.dockHeader}`}>
								<h2 className="font-medium text-sm">{title}</h2>
							</div>
							<PanelTabBar {...props} />
							<div className="space-y-2 p-4 text-xs">
								<p>
									Active tab:{" "}
									<span data-testid={`${side}-active`}>{props.activeUid}</span>
								</p>
								<p>
									Closed panel callbacks:{" "}
									{
										<span data-testid={`${side}-closed-panel-count`}>
											{closedPanelCount[side]}
										</span>
									}
								</p>
								<div
									className="flex flex-wrap gap-2"
									data-testid={`${side}-tab-list`}
								>
									{props.tabs.map((tab) => (
										<span
											className={`rounded-md border px-2 py-1 ${styles.tabReadback}`}
											data-pinned={tab.pinned === true}
											data-tab-uid={tab.uid}
											key={tab.uid}
										>
											{tab.uid} · {tab.kind} · {tab.label}
											{tab.pinned ? " · pinned" : ""}
										</span>
									))}
								</div>
							</div>
						</section>
					))}
				</div>
				<output className="sr-only" data-testid="callback-readback">
					{JSON.stringify({
						active: { bottom: bottomActive, right: rightActive },
						closedPanelCount,
						events,
						tabs: { bottom: bottomTabs, right: rightTabs },
					})}
				</output>
			</main>
		</TooltipProvider>
	);
}

createRoot(document.getElementById("root")!).render(<ProofArtifact />);

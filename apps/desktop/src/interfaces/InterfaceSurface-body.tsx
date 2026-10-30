import type { InterfacePort } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import {
	AquariumInterface,
	ArcadeInterface,
	ArenaInterface,
	BankInterface,
	BoardInterface,
	CalendarInterface,
	CanvasInterface,
	CardTableInterface,
	ChannelsInterface,
	CinemaInterface,
	CommunityInterface,
	DashboardInterface,
	DeparturesInterface,
	DeskInterface,
	FarmInterface,
	FeedInterface,
	FlowInterface,
	FocusInterface,
	ForumInterface,
	GalleryInterface,
	GlanceInterface,
	GraphInterface,
	HologramInterface,
	HubInterface,
	InboxInterface,
	JobsInterface,
	JournalInterface,
	KitchenInterface,
	KnowledgeInterface,
	LibraryInterface,
	LiveInterface,
	LobbyInterface,
	MailInterface,
	MarketInterface,
	MessengerInterface,
	MindmapInterface,
	MissionControlInterface,
	MomentsInterface,
	NewspaperInterface,
	NotebookInterface,
	NoticeboardInterface,
	PanelsInterface,
	PassportInterface,
	PathInterface,
	PersonaInterface,
	PlanetsInterface,
	PostsInterface,
	QaInterface,
	QuizInterface,
	RecordsInterface,
	RidesInterface,
	SeasonalInterface,
	SheetInterface,
	StatusInterface,
	StreamInterface,
	TerminalInterface,
	TickerInterface,
	TicketsInterface,
	TimelineInterface,
	TownInterface,
	TrackingInterface,
	WarehouseInterface,
	WikiInterface,
	WorkersInterface,
	World2dInterface,
	World3dInterface,
} from "./InterfaceSurface-lazy-renderers.tsx";
import type { resolveSurfaceRenderer } from "./surface-renderer.ts";
import type { InterfaceSnapshotState } from "./use-interface-snapshot.ts";

/** The props every renderer shares. */
export interface InterfaceBodyCommon {
	activeThreadId: string | null;
	loading: InterfaceSnapshotState["loading"];
	port: InterfacePort;
	snapshot: InterfaceSnapshotState["snapshot"];
	threadView: ReactNode;
}

/** The renderer element for a resolved interface, or null when none fits. */
export function interfaceBody(
	resolved: ReturnType<typeof resolveSurfaceRenderer>,
	common: InterfaceBodyCommon,
	lazyLayout: (node: ReactNode) => ReactNode
): ReactNode {
	let body: ReactNode;
	switch (resolved.renderer) {
		case "channels":
			body = lazyLayout(
				<ChannelsInterface {...common} params={resolved.params} />
			);
			break;
		case "feed":
			body = lazyLayout(<FeedInterface {...common} params={resolved.params} />);
			break;
		case "world-2d":
			body = lazyLayout(
				<World2dInterface {...common} params={resolved.params} />
			);
			break;
		case "world-3d":
			body = lazyLayout(
				<World3dInterface {...common} params={resolved.params} />
			);
			break;
		case "board":
			body = lazyLayout(
				<BoardInterface {...common} params={resolved.params} />
			);
			break;
		case "inbox":
			body = lazyLayout(
				<InboxInterface {...common} params={resolved.params} />
			);
			break;
		case "graph":
			body = lazyLayout(
				<GraphInterface {...common} params={resolved.params} />
			);
			break;
		case "timeline":
			body = lazyLayout(
				<TimelineInterface {...common} params={resolved.params} />
			);
			break;
		case "messenger":
			body = lazyLayout(
				<MessengerInterface {...common} params={resolved.params} />
			);
			break;
		case "terminal":
			body = lazyLayout(
				<TerminalInterface {...common} params={resolved.params} />
			);
			break;
		case "arena":
			body = lazyLayout(
				<ArenaInterface {...common} params={resolved.params} />
			);
			break;
		case "desk":
			body = lazyLayout(<DeskInterface {...common} params={resolved.params} />);
			break;
		case "card-table":
			body = lazyLayout(
				<CardTableInterface {...common} params={resolved.params} />
			);
			break;
		case "sheet":
			body = lazyLayout(
				<SheetInterface {...common} params={resolved.params} />
			);
			break;
		case "canvas":
			body = lazyLayout(
				<CanvasInterface {...common} params={resolved.params} />
			);
			break;
		case "calendar":
			body = lazyLayout(
				<CalendarInterface {...common} params={resolved.params} />
			);
			break;
		case "notebook":
			body = lazyLayout(
				<NotebookInterface {...common} params={resolved.params} />
			);
			break;
		case "mission-control":
			body = lazyLayout(
				<MissionControlInterface {...common} params={resolved.params} />
			);
			break;
		case "ticker":
			body = lazyLayout(
				<TickerInterface {...common} params={resolved.params} />
			);
			break;
		case "focus":
			body = lazyLayout(
				<FocusInterface {...common} params={resolved.params} />
			);
			break;
		case "aquarium":
			body = lazyLayout(
				<AquariumInterface {...common} params={resolved.params} />
			);
			break;
		case "planets":
			body = lazyLayout(
				<PlanetsInterface {...common} params={resolved.params} />
			);
			break;
		case "stream":
			body = lazyLayout(
				<StreamInterface {...common} params={resolved.params} />
			);
			break;
		case "forum":
			body = lazyLayout(
				<ForumInterface {...common} params={resolved.params} />
			);
			break;
		case "live":
			body = lazyLayout(<LiveInterface {...common} params={resolved.params} />);
			break;
		case "posts":
			body = lazyLayout(
				<PostsInterface {...common} params={resolved.params} />
			);
			break;
		case "community":
			body = lazyLayout(
				<CommunityInterface {...common} params={resolved.params} />
			);
			break;
		case "wiki":
			body = lazyLayout(<WikiInterface {...common} params={resolved.params} />);
			break;
		case "dashboard":
			body = lazyLayout(
				<DashboardInterface {...common} params={resolved.params} />
			);
			break;
		case "mindmap":
			body = lazyLayout(
				<MindmapInterface {...common} params={resolved.params} />
			);
			break;
		case "gallery":
			body = lazyLayout(
				<GalleryInterface {...common} params={resolved.params} />
			);
			break;
		case "newspaper":
			body = lazyLayout(
				<NewspaperInterface {...common} params={resolved.params} />
			);
			break;
		case "qa":
			body = lazyLayout(<QaInterface {...common} params={resolved.params} />);
			break;
		case "cinema":
			body = lazyLayout(
				<CinemaInterface {...common} params={resolved.params} />
			);
			break;
		case "noticeboard":
			body = lazyLayout(
				<NoticeboardInterface {...common} params={resolved.params} />
			);
			break;
		case "mail":
			body = lazyLayout(<MailInterface {...common} params={resolved.params} />);
			break;
		case "status":
			body = lazyLayout(
				<StatusInterface {...common} params={resolved.params} />
			);
			break;
		case "records":
			body = lazyLayout(
				<RecordsInterface {...common} params={resolved.params} />
			);
			break;
		case "path":
			body = lazyLayout(<PathInterface {...common} params={resolved.params} />);
			break;
		case "glance":
			body = lazyLayout(
				<GlanceInterface {...common} params={resolved.params} />
			);
			break;
		case "hub":
			body = lazyLayout(<HubInterface {...common} params={resolved.params} />);
			break;
		case "library":
			body = lazyLayout(
				<LibraryInterface {...common} params={resolved.params} />
			);
			break;
		case "tickets":
			body = lazyLayout(
				<TicketsInterface {...common} params={resolved.params} />
			);
			break;
		case "persona":
			body = lazyLayout(
				<PersonaInterface {...common} params={resolved.params} />
			);
			break;
		case "panels":
			body = lazyLayout(
				<PanelsInterface {...common} params={resolved.params} />
			);
			break;
		case "departures":
			body = lazyLayout(
				<DeparturesInterface {...common} params={resolved.params} />
			);
			break;
		case "tracking":
			body = lazyLayout(
				<TrackingInterface {...common} params={resolved.params} />
			);
			break;
		case "flow":
			body = lazyLayout(<FlowInterface {...common} params={resolved.params} />);
			break;
		case "moments":
			body = lazyLayout(
				<MomentsInterface {...common} params={resolved.params} />
			);
			break;
		case "kitchen":
			body = lazyLayout(
				<KitchenInterface {...common} params={resolved.params} />
			);
			break;
		case "market":
			body = lazyLayout(
				<MarketInterface {...common} params={resolved.params} />
			);
			break;
		case "workers":
			body = lazyLayout(
				<WorkersInterface {...common} params={resolved.params} />
			);
			break;
		case "arcade":
			body = lazyLayout(
				<ArcadeInterface {...common} params={resolved.params} />
			);
			break;
		case "farm":
			body = lazyLayout(<FarmInterface {...common} params={resolved.params} />);
			break;
		case "town":
			body = lazyLayout(<TownInterface {...common} params={resolved.params} />);
			break;
		case "rides":
			body = lazyLayout(
				<RidesInterface {...common} params={resolved.params} />
			);
			break;
		case "journal":
			body = lazyLayout(
				<JournalInterface {...common} params={resolved.params} />
			);
			break;
		case "passport":
			body = lazyLayout(
				<PassportInterface {...common} params={resolved.params} />
			);
			break;
		case "lobby":
			body = lazyLayout(
				<LobbyInterface {...common} params={resolved.params} />
			);
			break;
		case "seasonal":
			body = lazyLayout(
				<SeasonalInterface {...common} params={resolved.params} />
			);
			break;
		case "bank":
			body = lazyLayout(<BankInterface {...common} params={resolved.params} />);
			break;
		case "quiz":
			body = lazyLayout(<QuizInterface {...common} params={resolved.params} />);
			break;
		case "jobs":
			body = lazyLayout(<JobsInterface {...common} params={resolved.params} />);
			break;
		case "knowledge":
			body = lazyLayout(
				<KnowledgeInterface {...common} params={resolved.params} />
			);
			break;
		case "hologram":
			body = lazyLayout(
				<HologramInterface {...common} params={resolved.params} />
			);
			break;
		case "warehouse":
			body = lazyLayout(
				<WarehouseInterface {...common} params={resolved.params} />
			);
			break;
		default:
			body = null;
	}
	return body;
}

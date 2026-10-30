import { lazy } from "react";

// Every renderer loads on demand, so a session pays only for the interface it
// shows (Layout imports this host statically, so a static import here would
// ship every renderer, and World 2D's scene modules, to OS and Console users).
export const ChannelsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/channels-interface.tsx").then(
		(module) => ({ default: module.ChannelsInterface })
	)
);
export const FeedInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/feed-interface.tsx").then(
		(module) => ({ default: module.FeedInterface })
	)
);
export const World2dInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/world-2d-interface.tsx").then(
		(module) => ({ default: module.World2dInterface })
	)
);

// three.js and react-three-fiber are heavy; only the 3D world pays for them.
export const World3dInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/world-3d-interface.tsx").then(
		(module) => ({ default: module.World3dInterface })
	)
);

// The layout interfaces load on demand so the shell only ships the one in use
// (Graph pulls in the flow-graph library).
export const BoardInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/board-interface.tsx").then(
		(module) => ({ default: module.BoardInterface })
	)
);
export const InboxInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/inbox-interface.tsx").then(
		(module) => ({ default: module.InboxInterface })
	)
);
export const GraphInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/graph-interface.tsx").then(
		(module) => ({ default: module.GraphInterface })
	)
);
export const TimelineInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/timeline-interface.tsx").then(
		(module) => ({ default: module.TimelineInterface })
	)
);
export const MessengerInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/messenger-interface.tsx").then(
		(module) => ({ default: module.MessengerInterface })
	)
);
export const TerminalInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/terminal-interface.tsx").then(
		(module) => ({ default: module.TerminalInterface })
	)
);
export const ArenaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/arena-interface.tsx").then(
		(module) => ({ default: module.ArenaInterface })
	)
);

export const DeskInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/desk-interface.tsx").then(
		(module) => ({ default: module.DeskInterface })
	)
);

export const CardTableInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/card-table-interface.tsx").then(
		(module) => ({ default: module.CardTableInterface })
	)
);
export const SheetInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/sheet-interface.tsx").then(
		(module) => ({ default: module.SheetInterface })
	)
);
export const CanvasInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/canvas-interface.tsx").then(
		(module) => ({ default: module.CanvasInterface })
	)
);
export const CalendarInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/calendar-interface.tsx").then(
		(module) => ({ default: module.CalendarInterface })
	)
);
export const NotebookInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/notebook-interface.tsx").then(
		(module) => ({ default: module.NotebookInterface })
	)
);
export const MissionControlInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/mission-control-interface.tsx").then(
		(module) => ({ default: module.MissionControlInterface })
	)
);
export const TickerInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/ticker-interface.tsx").then(
		(module) => ({ default: module.TickerInterface })
	)
);
export const FocusInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/focus-interface.tsx").then(
		(module) => ({ default: module.FocusInterface })
	)
);
export const AquariumInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/aquarium-interface.tsx").then(
		(module) => ({ default: module.AquariumInterface })
	)
);

export const PlanetsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/planets-interface.tsx").then(
		(module) => ({ default: module.PlanetsInterface })
	)
);

export const StreamInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/stream-interface.tsx").then(
		(module) => ({ default: module.StreamInterface })
	)
);
export const ForumInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/forum-interface.tsx").then(
		(module) => ({ default: module.ForumInterface })
	)
);

export const LiveInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/live-interface.tsx").then(
		(module) => ({ default: module.LiveInterface })
	)
);

export const PostsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/posts-interface.tsx").then(
		(module) => ({ default: module.PostsInterface })
	)
);
export const CommunityInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/community-interface.tsx").then(
		(module) => ({ default: module.CommunityInterface })
	)
);
export const WikiInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/wiki-interface.tsx").then(
		(module) => ({ default: module.WikiInterface })
	)
);
export const DashboardInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/dashboard-interface.tsx").then(
		(module) => ({ default: module.DashboardInterface })
	)
);
export const MindmapInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/mindmap-interface.tsx").then(
		(module) => ({ default: module.MindmapInterface })
	)
);
export const GalleryInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/gallery-interface.tsx").then(
		(module) => ({ default: module.GalleryInterface })
	)
);
export const NewspaperInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/newspaper-interface.tsx").then(
		(module) => ({ default: module.NewspaperInterface })
	)
);

export const QaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/qa-interface.tsx").then((module) => ({
		default: module.QaInterface,
	}))
);
export const CinemaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/cinema-interface.tsx").then(
		(module) => ({ default: module.CinemaInterface })
	)
);
export const NoticeboardInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/noticeboard-interface.tsx").then(
		(module) => ({ default: module.NoticeboardInterface })
	)
);

export const MailInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/mail-interface.tsx").then(
		(module) => ({ default: module.MailInterface })
	)
);
export const StatusInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/status-interface.tsx").then(
		(module) => ({ default: module.StatusInterface })
	)
);
export const RecordsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/records-interface.tsx").then(
		(module) => ({ default: module.RecordsInterface })
	)
);

export const PathInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/path-interface.tsx").then(
		(module) => ({ default: module.PathInterface })
	)
);
export const GlanceInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/glance-interface.tsx").then(
		(module) => ({ default: module.GlanceInterface })
	)
);
export const HubInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/hub-interface.tsx").then((module) => ({
		default: module.HubInterface,
	}))
);

export const LibraryInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/library-interface.tsx").then(
		(module) => ({ default: module.LibraryInterface })
	)
);

export const TicketsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/tickets-interface.tsx").then(
		(module) => ({ default: module.TicketsInterface })
	)
);

export const PersonaInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/persona-interface.tsx").then(
		(module) => ({ default: module.PersonaInterface })
	)
);
export const PanelsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/panels-interface.tsx").then(
		(module) => ({ default: module.PanelsInterface })
	)
);
export const DeparturesInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/departures-interface.tsx").then(
		(module) => ({ default: module.DeparturesInterface })
	)
);
export const TrackingInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/tracking-interface.tsx").then(
		(module) => ({ default: module.TrackingInterface })
	)
);
export const FlowInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/flow-interface.tsx").then(
		(module) => ({ default: module.FlowInterface })
	)
);
export const MomentsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/moments-interface.tsx").then(
		(module) => ({ default: module.MomentsInterface })
	)
);
export const KitchenInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/kitchen-interface.tsx").then(
		(module) => ({ default: module.KitchenInterface })
	)
);
export const MarketInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/market-interface.tsx").then(
		(module) => ({ default: module.MarketInterface })
	)
);
export const WorkersInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/workers-interface.tsx").then(
		(module) => ({ default: module.WorkersInterface })
	)
);

export const ArcadeInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/arcade-interface.tsx").then(
		(module) => ({ default: module.ArcadeInterface })
	)
);
export const FarmInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/farm-interface.tsx").then(
		(module) => ({ default: module.FarmInterface })
	)
);
export const TownInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/town-interface.tsx").then(
		(module) => ({ default: module.TownInterface })
	)
);
export const RidesInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/rides-interface.tsx").then(
		(module) => ({ default: module.RidesInterface })
	)
);
export const JournalInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/journal-interface.tsx").then(
		(module) => ({ default: module.JournalInterface })
	)
);
export const PassportInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/passport-interface.tsx").then(
		(module) => ({ default: module.PassportInterface })
	)
);
export const LobbyInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/lobby-interface.tsx").then(
		(module) => ({ default: module.LobbyInterface })
	)
);
export const SeasonalInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/seasonal-interface.tsx").then(
		(module) => ({ default: module.SeasonalInterface })
	)
);
export const BankInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/bank-interface.tsx").then(
		(module) => ({ default: module.BankInterface })
	)
);
export const QuizInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/quiz-interface.tsx").then(
		(module) => ({ default: module.QuizInterface })
	)
);
export const JobsInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/jobs-interface.tsx").then(
		(module) => ({ default: module.JobsInterface })
	)
);
export const KnowledgeInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/knowledge-interface.tsx").then(
		(module) => ({ default: module.KnowledgeInterface })
	)
);
export const HologramInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/hologram-interface.tsx").then(
		(module) => ({ default: module.HologramInterface })
	)
);
export const WarehouseInterface = lazy(() =>
	import("@ryu/blocks/desktop/interfaces/warehouse-interface.tsx").then(
		(module) => ({ default: module.WarehouseInterface })
	)
);

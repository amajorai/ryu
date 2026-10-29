import {
	type InterfaceDescriptor,
	type InterfaceParamsByRenderer,
	resolveInterfaceParams,
} from "@ryuhq/protocol/interfaces";

/** A descriptor's renderer paired with its resolved, typed params. */
export type ResolvedRenderer =
	| { params: InterfaceParamsByRenderer["channels"]; renderer: "channels" }
	| { params: InterfaceParamsByRenderer["feed"]; renderer: "feed" }
	| { params: InterfaceParamsByRenderer["world-2d"]; renderer: "world-2d" }
	| { params: InterfaceParamsByRenderer["world-3d"]; renderer: "world-3d" }
	| { params: InterfaceParamsByRenderer["board"]; renderer: "board" }
	| { params: InterfaceParamsByRenderer["inbox"]; renderer: "inbox" }
	| { params: InterfaceParamsByRenderer["graph"]; renderer: "graph" }
	| { params: InterfaceParamsByRenderer["timeline"]; renderer: "timeline" }
	| { params: InterfaceParamsByRenderer["messenger"]; renderer: "messenger" }
	| { params: InterfaceParamsByRenderer["terminal"]; renderer: "terminal" }
	| { params: InterfaceParamsByRenderer["arena"]; renderer: "arena" }
	| { params: InterfaceParamsByRenderer["desk"]; renderer: "desk" }
	| {
			params: InterfaceParamsByRenderer["card-table"];
			renderer: "card-table";
	  }
	| {
			params: InterfaceParamsByRenderer["sheet"];
			renderer: "sheet";
	  }
	| {
			params: InterfaceParamsByRenderer["canvas"];
			renderer: "canvas";
	  }
	| {
			params: InterfaceParamsByRenderer["calendar"];
			renderer: "calendar";
	  }
	| {
			params: InterfaceParamsByRenderer["notebook"];
			renderer: "notebook";
	  }
	| {
			params: InterfaceParamsByRenderer["mission-control"];
			renderer: "mission-control";
	  }
	| {
			params: InterfaceParamsByRenderer["ticker"];
			renderer: "ticker";
	  }
	| {
			params: InterfaceParamsByRenderer["focus"];
			renderer: "focus";
	  }
	| {
			params: InterfaceParamsByRenderer["aquarium"];
			renderer: "aquarium";
	  }
	| {
			params: InterfaceParamsByRenderer["planets"];
			renderer: "planets";
	  }
	| {
			params: InterfaceParamsByRenderer["stream"];
			renderer: "stream";
	  }
	| {
			params: InterfaceParamsByRenderer["forum"];
			renderer: "forum";
	  }
	| { params: InterfaceParamsByRenderer["live"]; renderer: "live" }
	| {
			params: InterfaceParamsByRenderer["posts"];
			renderer: "posts";
	  }
	| {
			params: InterfaceParamsByRenderer["community"];
			renderer: "community";
	  }
	| {
			params: InterfaceParamsByRenderer["wiki"];
			renderer: "wiki";
	  }
	| {
			params: InterfaceParamsByRenderer["dashboard"];
			renderer: "dashboard";
	  }
	| {
			params: InterfaceParamsByRenderer["mindmap"];
			renderer: "mindmap";
	  }
	| {
			params: InterfaceParamsByRenderer["gallery"];
			renderer: "gallery";
	  }
	| {
			params: InterfaceParamsByRenderer["newspaper"];
			renderer: "newspaper";
	  }
	| {
			params: InterfaceParamsByRenderer["qa"];
			renderer: "qa";
	  }
	| {
			params: InterfaceParamsByRenderer["cinema"];
			renderer: "cinema";
	  }
	| {
			params: InterfaceParamsByRenderer["noticeboard"];
			renderer: "noticeboard";
	  }
	| {
			params: InterfaceParamsByRenderer["mail"];
			renderer: "mail";
	  }
	| {
			params: InterfaceParamsByRenderer["status"];
			renderer: "status";
	  }
	| {
			params: InterfaceParamsByRenderer["records"];
			renderer: "records";
	  }
	| {
			params: InterfaceParamsByRenderer["path"];
			renderer: "path";
	  }
	| {
			params: InterfaceParamsByRenderer["glance"];
			renderer: "glance";
	  }
	| {
			params: InterfaceParamsByRenderer["hub"];
			renderer: "hub";
	  }
	| {
			params: InterfaceParamsByRenderer["library"];
			renderer: "library";
	  }
	| {
			params: InterfaceParamsByRenderer["tickets"];
			renderer: "tickets";
	  }
	| {
			params: InterfaceParamsByRenderer["persona"];
			renderer: "persona";
	  }
	| {
			params: InterfaceParamsByRenderer["panels"];
			renderer: "panels";
	  }
	| {
			params: InterfaceParamsByRenderer["departures"];
			renderer: "departures";
	  }
	| {
			params: InterfaceParamsByRenderer["tracking"];
			renderer: "tracking";
	  }
	| {
			params: InterfaceParamsByRenderer["flow"];
			renderer: "flow";
	  }
	| {
			params: InterfaceParamsByRenderer["moments"];
			renderer: "moments";
	  }
	| {
			params: InterfaceParamsByRenderer["kitchen"];
			renderer: "kitchen";
	  }
	| {
			params: InterfaceParamsByRenderer["market"];
			renderer: "market";
	  }
	| {
			params: InterfaceParamsByRenderer["workers"];
			renderer: "workers";
	  }
	| {
			params: InterfaceParamsByRenderer["arcade"];
			renderer: "arcade";
	  }
	| {
			params: InterfaceParamsByRenderer["farm"];
			renderer: "farm";
	  }
	| {
			params: InterfaceParamsByRenderer["town"];
			renderer: "town";
	  }
	| {
			params: InterfaceParamsByRenderer["rides"];
			renderer: "rides";
	  }
	| {
			params: InterfaceParamsByRenderer["journal"];
			renderer: "journal";
	  }
	| {
			params: InterfaceParamsByRenderer["passport"];
			renderer: "passport";
	  }
	| {
			params: InterfaceParamsByRenderer["lobby"];
			renderer: "lobby";
	  }
	| {
			params: InterfaceParamsByRenderer["seasonal"];
			renderer: "seasonal";
	  }
	| {
			params: InterfaceParamsByRenderer["bank"];
			renderer: "bank";
	  }
	| {
			params: InterfaceParamsByRenderer["quiz"];
			renderer: "quiz";
	  }
	| {
			params: InterfaceParamsByRenderer["jobs"];
			renderer: "jobs";
	  }
	| {
			params: InterfaceParamsByRenderer["knowledge"];
			renderer: "knowledge";
	  }
	| {
			params: InterfaceParamsByRenderer["hologram"];
			renderer: "hologram";
	  }
	| {
			params: InterfaceParamsByRenderer["warehouse"];
			renderer: "warehouse";
	  }
	| { renderer: "unsupported" };

/**
 * Resolve untrusted descriptor params once per descriptor. Bot, OS, and
 * Console are whole shells rather than surface renderers, so they never
 * render here.
 */
export function resolveSurfaceRenderer(
	descriptor: InterfaceDescriptor
): ResolvedRenderer {
	switch (descriptor.renderer) {
		case "channels":
			return {
				params: resolveInterfaceParams("channels", descriptor.params),
				renderer: "channels",
			};
		case "feed":
			return {
				params: resolveInterfaceParams("feed", descriptor.params),
				renderer: "feed",
			};
		case "world-2d":
			return {
				params: resolveInterfaceParams("world-2d", descriptor.params),
				renderer: "world-2d",
			};
		case "world-3d":
			return {
				params: resolveInterfaceParams("world-3d", descriptor.params),
				renderer: "world-3d",
			};
		case "board":
			return {
				params: resolveInterfaceParams("board", descriptor.params),
				renderer: "board",
			};
		case "inbox":
			return {
				params: resolveInterfaceParams("inbox", descriptor.params),
				renderer: "inbox",
			};
		case "graph":
			return {
				params: resolveInterfaceParams("graph", descriptor.params),
				renderer: "graph",
			};
		case "timeline":
			return {
				params: resolveInterfaceParams("timeline", descriptor.params),
				renderer: "timeline",
			};
		case "messenger":
			return {
				params: resolveInterfaceParams("messenger", descriptor.params),
				renderer: "messenger",
			};
		case "terminal":
			return {
				params: resolveInterfaceParams("terminal", descriptor.params),
				renderer: "terminal",
			};
		case "arena":
			return {
				params: resolveInterfaceParams("arena", descriptor.params),
				renderer: "arena",
			};
		case "desk":
			return {
				params: resolveInterfaceParams("desk", descriptor.params),
				renderer: "desk",
			};
		case "card-table":
			return {
				params: resolveInterfaceParams("card-table", descriptor.params),
				renderer: "card-table",
			};
		case "sheet":
			return {
				params: resolveInterfaceParams("sheet", descriptor.params),
				renderer: "sheet",
			};
		case "canvas":
			return {
				params: resolveInterfaceParams("canvas", descriptor.params),
				renderer: "canvas",
			};
		case "calendar":
			return {
				params: resolveInterfaceParams("calendar", descriptor.params),
				renderer: "calendar",
			};
		case "notebook":
			return {
				params: resolveInterfaceParams("notebook", descriptor.params),
				renderer: "notebook",
			};
		case "mission-control":
			return {
				params: resolveInterfaceParams("mission-control", descriptor.params),
				renderer: "mission-control",
			};
		case "ticker":
			return {
				params: resolveInterfaceParams("ticker", descriptor.params),
				renderer: "ticker",
			};
		case "focus":
			return {
				params: resolveInterfaceParams("focus", descriptor.params),
				renderer: "focus",
			};
		case "aquarium":
			return {
				params: resolveInterfaceParams("aquarium", descriptor.params),
				renderer: "aquarium",
			};
		case "planets":
			return {
				params: resolveInterfaceParams("planets", descriptor.params),
				renderer: "planets",
			};
		case "stream":
			return {
				params: resolveInterfaceParams("stream", descriptor.params),
				renderer: "stream",
			};
		case "forum":
			return {
				params: resolveInterfaceParams("forum", descriptor.params),
				renderer: "forum",
			};
		case "live":
			return {
				params: resolveInterfaceParams("live", descriptor.params),
				renderer: "live",
			};
		case "posts":
			return {
				params: resolveInterfaceParams("posts", descriptor.params),
				renderer: "posts",
			};
		case "community":
			return {
				params: resolveInterfaceParams("community", descriptor.params),
				renderer: "community",
			};
		case "wiki":
			return {
				params: resolveInterfaceParams("wiki", descriptor.params),
				renderer: "wiki",
			};
		case "dashboard":
			return {
				params: resolveInterfaceParams("dashboard", descriptor.params),
				renderer: "dashboard",
			};
		case "mindmap":
			return {
				params: resolveInterfaceParams("mindmap", descriptor.params),
				renderer: "mindmap",
			};
		case "gallery":
			return {
				params: resolveInterfaceParams("gallery", descriptor.params),
				renderer: "gallery",
			};
		case "newspaper":
			return {
				params: resolveInterfaceParams("newspaper", descriptor.params),
				renderer: "newspaper",
			};
		case "qa":
			return {
				params: resolveInterfaceParams("qa", descriptor.params),
				renderer: "qa",
			};
		case "cinema":
			return {
				params: resolveInterfaceParams("cinema", descriptor.params),
				renderer: "cinema",
			};
		case "noticeboard":
			return {
				params: resolveInterfaceParams("noticeboard", descriptor.params),
				renderer: "noticeboard",
			};
		case "mail":
			return {
				params: resolveInterfaceParams("mail", descriptor.params),
				renderer: "mail",
			};
		case "status":
			return {
				params: resolveInterfaceParams("status", descriptor.params),
				renderer: "status",
			};
		case "records":
			return {
				params: resolveInterfaceParams("records", descriptor.params),
				renderer: "records",
			};
		case "path":
			return {
				params: resolveInterfaceParams("path", descriptor.params),
				renderer: "path",
			};
		case "glance":
			return {
				params: resolveInterfaceParams("glance", descriptor.params),
				renderer: "glance",
			};
		case "hub":
			return {
				params: resolveInterfaceParams("hub", descriptor.params),
				renderer: "hub",
			};
		case "library":
			return {
				params: resolveInterfaceParams("library", descriptor.params),
				renderer: "library",
			};
		case "tickets":
			return {
				params: resolveInterfaceParams("tickets", descriptor.params),
				renderer: "tickets",
			};
		case "persona":
			return {
				params: resolveInterfaceParams("persona", descriptor.params),
				renderer: "persona",
			};
		case "panels":
			return {
				params: resolveInterfaceParams("panels", descriptor.params),
				renderer: "panels",
			};
		case "departures":
			return {
				params: resolveInterfaceParams("departures", descriptor.params),
				renderer: "departures",
			};
		case "tracking":
			return {
				params: resolveInterfaceParams("tracking", descriptor.params),
				renderer: "tracking",
			};
		case "flow":
			return {
				params: resolveInterfaceParams("flow", descriptor.params),
				renderer: "flow",
			};
		case "moments":
			return {
				params: resolveInterfaceParams("moments", descriptor.params),
				renderer: "moments",
			};
		case "kitchen":
			return {
				params: resolveInterfaceParams("kitchen", descriptor.params),
				renderer: "kitchen",
			};
		case "market":
			return {
				params: resolveInterfaceParams("market", descriptor.params),
				renderer: "market",
			};
		case "workers":
			return {
				params: resolveInterfaceParams("workers", descriptor.params),
				renderer: "workers",
			};
		case "arcade":
			return {
				params: resolveInterfaceParams("arcade", descriptor.params),
				renderer: "arcade",
			};
		case "farm":
			return {
				params: resolveInterfaceParams("farm", descriptor.params),
				renderer: "farm",
			};
		case "town":
			return {
				params: resolveInterfaceParams("town", descriptor.params),
				renderer: "town",
			};
		case "rides":
			return {
				params: resolveInterfaceParams("rides", descriptor.params),
				renderer: "rides",
			};
		case "journal":
			return {
				params: resolveInterfaceParams("journal", descriptor.params),
				renderer: "journal",
			};
		case "passport":
			return {
				params: resolveInterfaceParams("passport", descriptor.params),
				renderer: "passport",
			};
		case "lobby":
			return {
				params: resolveInterfaceParams("lobby", descriptor.params),
				renderer: "lobby",
			};
		case "seasonal":
			return {
				params: resolveInterfaceParams("seasonal", descriptor.params),
				renderer: "seasonal",
			};
		case "bank":
			return {
				params: resolveInterfaceParams("bank", descriptor.params),
				renderer: "bank",
			};
		case "quiz":
			return {
				params: resolveInterfaceParams("quiz", descriptor.params),
				renderer: "quiz",
			};
		case "jobs":
			return {
				params: resolveInterfaceParams("jobs", descriptor.params),
				renderer: "jobs",
			};
		case "knowledge":
			return {
				params: resolveInterfaceParams("knowledge", descriptor.params),
				renderer: "knowledge",
			};
		case "hologram":
			return {
				params: resolveInterfaceParams("hologram", descriptor.params),
				renderer: "hologram",
			};
		case "warehouse":
			return {
				params: resolveInterfaceParams("warehouse", descriptor.params),
				renderer: "warehouse",
			};
		default:
			return { renderer: "unsupported" };
	}
}

/** The open conversation surface is the chat route, with or without an id. */
export function isChatTabPath(path: string): boolean {
	return path === "/chat" || path.startsWith("/chat/");
}

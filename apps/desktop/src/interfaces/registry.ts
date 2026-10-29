// The desktop's interface catalog: which presentation layers the product
// switcher can offer, and which one is active.
//
// Bot, OS, and Console were the first three interfaces; Channels, Feed, and the
// 2D/3D worlds render the same agents and threads differently. Every entry is an
// `InterfaceDescriptor` from `@ryuhq/protocol/interfaces`, so built-ins and
// Marketplace contributions share one list, one resolver, and one switcher.
//
// Everything in this module is pure so the switcher's gating and the active
// interface fallback stay unit-testable without a store or a React tree.

import {
	builtinInterfaceId,
	type InterfaceDescriptor,
	type InterfaceRenderer,
	interfaceTier,
	isInterfaceId,
} from "@ryuhq/protocol/interfaces";
import type { ProductMode, StartupRealm } from "@/src/lib/product-mode.ts";

function builtin(
	renderer: InterfaceRenderer,
	label: string,
	description: string
): InterfaceDescriptor {
	return {
		description,
		id: builtinInterfaceId(renderer),
		label,
		origin: "builtin",
		params: {},
		renderer,
	};
}

/** Interfaces that ship with Ryu, in switcher order. */
export const BUILTIN_INTERFACES: readonly InterfaceDescriptor[] = [
	builtin("bot", "Bot", "Managed chat, ready to use"),
	builtin("os", "OS", "Dock, windows, and App Launcher for Ryu Apps"),
	builtin(
		"console",
		"Agent",
		"Configure nodes, models, and organization controls"
	),
	builtin(
		"channels",
		"Channels",
		"Agents as direct messages, teams as channels"
	),
	builtin("feed", "Feed", "A timeline where every thread is a post"),
	builtin("world-2d", "World 2D", "Walk a tile world and talk to agents"),
	builtin("world-3d", "World 3D", "Explore a 3D world and talk to agents"),
	builtin("board", "Board", "Threads as cards in columns by status"),
	builtin("inbox", "Inbox", "Triage what needs you, most urgent first"),
	builtin("graph", "Graph", "A live map of who works with whom"),
	builtin("timeline", "Timeline", "Threads laid out across days and weeks"),
	builtin("messenger", "Messenger", "Agents as contacts, one chat each"),
	builtin("terminal", "Terminal", "A keyboard-first command line"),
	builtin("arena", "Arena", "A wall of live agent cards"),
	builtin("desk", "Desk", "Help-desk views, conversations, and details"),
	builtin(
		"card-table",
		"Card Table",
		"Agents seated at a card table, your turns as a hand"
	),
	builtin("sheet", "Sheet", "Every thread as a row in a sortable grid"),
	builtin(
		"canvas",
		"Canvas",
		"Threads as cards on an infinite board you arrange"
	),
	builtin(
		"calendar",
		"Calendar",
		"Threads and scheduled runs on a month or week"
	),
	builtin("notebook", "Notebook", "Threads as pages in a notebook"),
	builtin(
		"mission-control",
		"Mission Control",
		"A live wall of status, totals, and alerts"
	),
	builtin("ticker", "Ticker", "Agents as tickers with an activity tape"),
	builtin("focus", "Focus", "One thread at a time, most urgent first"),
	builtin("aquarium", "Aquarium", "Agents as creatures in a living tank"),
	builtin(
		"planets",
		"Planets",
		"Agents as planets orbiting you, threads as moons"
	),
	builtin("stream", "Stream", "A single-column stream of threads and replies"),
	builtin(
		"forum",
		"Forum",
		"Categories, topics, and replies, like a classic forum"
	),
	builtin("live", "Live", "Agents as live channels, the thread as chat"),
	builtin(
		"posts",
		"Posts",
		"Async posts in spaces, with comments and feedback"
	),
	builtin(
		"community",
		"Community",
		"Communities of posts with votes and comments"
	),
	builtin("wiki", "Wiki", "An encyclopedia of agents, teams, and threads"),
	builtin("dashboard", "Dashboard", "A grid of widgets you arrange yourself"),
	builtin(
		"mindmap",
		"Mind Map",
		"Everything branching out from you as a mind map"
	),
	builtin("gallery", "Gallery", "Threads as a masonry gallery of covers"),
	builtin("newspaper", "Newspaper", "Your threads as a daily newspaper"),
	builtin("qa", "Q&A", "Threads as questions, agent replies as answers"),
	builtin(
		"cinema",
		"Cinema",
		"Rows of threads to browse like a streaming service"
	),
	builtin("noticeboard", "Noticeboard", "Threads pinned to a cork board"),
	builtin("mail", "Mail", "Folders, a message list, and a reading pane"),
	builtin(
		"status",
		"Status",
		"A status page: agents as components, incidents, uptime"
	),
	builtin(
		"records",
		"Records",
		"Agents as records with fields and an activity timeline"
	),
	builtin("path", "Path", "Projects as units, threads as steps along a path"),
	builtin(
		"glance",
		"Glance",
		"Minimal faces and widgets that adapt to distance"
	),
	builtin("hub", "Hub", "An ambient clock that opens into glanceable cards"),
	builtin("library", "Library", "Agents as books, threads as chapters"),
	builtin(
		"tickets",
		"Tickets",
		"A support ticket queue with views, priorities, and SLAs"
	),
	builtin(
		"persona",
		"Persona",
		"A chat-first personal agent with side chats, ideas, and goals"
	),
	builtin("panels", "Panels", "Action cards and panels over a live sky"),
	builtin(
		"departures",
		"Departures",
		"Threads as flights on a departures board"
	),
	builtin("tracking", "Tracking", "Threads as parcels with delivery tracking"),
	builtin(
		"flow",
		"Flow",
		"A minimal canvas that grows from one card into a flow"
	),
	builtin(
		"moments",
		"Moments",
		"Ambient flows of your day, one focused card at a time"
	),
	builtin("kitchen", "Kitchen", "Agents as chefs cooking your orders"),
	builtin(
		"market",
		"Market",
		"A street of shops: projects as shops, agents as shopkeepers"
	),
	builtin("workers", "Workers", "Each agent at its own computer"),
	builtin(
		"arcade",
		"Arcade",
		"Agents as slot machines on a casino and arcade floor"
	),
	builtin("farm", "Farm", "Agents tend plots where threads grow into fruit"),
	builtin(
		"town",
		"Town",
		"Be the mayor: projects as districts, agents as buildings"
	),
	builtin(
		"rides",
		"Rides",
		"Agents as drivers on a city map, threads as trips"
	),
	builtin("journal", "Journal", "Your threads as dated journal entries"),
	builtin(
		"passport",
		"Passport",
		"Agents as countries, threads as passport stamps"
	),
	builtin("lobby", "Lobby", "A game lobby with your squad and a quest board"),
	builtin(
		"seasonal",
		"Seasonal",
		"An advent calendar and other seasonal boards"
	),
	builtin("bank", "Bank", "Your balance, spending, and transactions"),
	builtin("quiz", "Quiz Show", "A quiz board of categories and clues"),
	builtin("jobs", "Jobs", "Threads as job postings, agents as freelancers"),
	builtin(
		"knowledge",
		"Knowledge",
		"A knowledge graph of agents, threads, and topics"
	),
	builtin("hologram", "Hologram", "A holographic command HUD"),
	builtin(
		"warehouse",
		"Warehouse",
		"Threads as orders moving through a warehouse"
	),
];

/**
 * Creator credit for a Marketplace interface (its attribution, else the owning
 * plugin), or null for a built-in. The manifest contract promises the credit
 * is shown with the interface, so every surface that names one shows this.
 */
export function interfaceCredit(
	descriptor: InterfaceDescriptor
): string | null {
	if (descriptor.origin !== "marketplace") {
		return null;
	}
	return descriptor.attribution ?? descriptor.plugin ?? "Marketplace";
}

/** Id of the default workspace interface (the OS desktop). */
export const DEFAULT_WORKSPACE_INTERFACE_ID = builtinInterfaceId("os");

function builtinFor(renderer: InterfaceRenderer): InterfaceDescriptor {
	const descriptor = BUILTIN_INTERFACES.find(
		(entry) => entry.renderer === renderer
	);
	if (!descriptor) {
		throw new Error(`Missing built-in interface for ${renderer}`);
	}
	return descriptor;
}

export const BOT_INTERFACE = builtinFor("bot");
export const OS_INTERFACE = builtinFor("os");
export const CONSOLE_INTERFACE = builtinFor("console");

export interface AvailableInterfacesInput {
	/** Org owners/admins of a managed node (or a local node) may open Console. */
	canSwitchToConsole: boolean;
	/** The workspace tier: the OS desktop (behind the `ui.interface_os` flag). */
	canSwitchToOs: boolean;
	/** Marketplace interfaces from enabled plugins, already validated. */
	contributed: readonly InterfaceDescriptor[];
	/**
	 * Workspace interfaces beyond the OS desktop: Channels, Feed, the worlds,
	 * the layouts, and every Marketplace interface (`ui.workspace_interfaces`).
	 * Only meaningful with {@link canSwitchToOs}.
	 */
	workspaceInterfaces: boolean;
}

/** Whether a workspace interface needs the `ui.workspace_interfaces` flag. */
function isBeyondOs(descriptor: InterfaceDescriptor): boolean {
	return descriptor.origin !== "builtin" || descriptor.renderer !== "os";
}

function isAllowed(
	descriptor: InterfaceDescriptor,
	{
		canSwitchToConsole,
		canSwitchToOs,
		workspaceInterfaces,
	}: AvailableInterfacesInput
): boolean {
	switch (interfaceTier(descriptor.renderer)) {
		case "managed":
			return true;
		case "admin":
			return canSwitchToConsole;
		case "workspace":
			return canSwitchToOs && (workspaceInterfaces || !isBeyondOs(descriptor));
		default:
			return false;
	}
}

/**
 * The switcher list: Bot always; Console only with Console access; OS only
 * when the workspace is rolled out; every other workspace interface (built-in
 * or Marketplace) only when those are rolled out too. Marketplace entries follow the built-ins and can only select
 * workspace renderers, so a plugin can never surface the managed or admin shell.
 */
export function availableInterfaces(
	input: AvailableInterfacesInput
): InterfaceDescriptor[] {
	const builtins = BUILTIN_INTERFACES.filter((descriptor) =>
		isAllowed(descriptor, input)
	);
	const contributed = input.contributed.filter(
		(descriptor) =>
			descriptor.origin === "marketplace" &&
			!BUILTIN_INTERFACES.some((entry) => entry.id === descriptor.id) &&
			interfaceTier(descriptor.renderer) === "workspace" &&
			isAllowed(descriptor, input)
	);
	return [...builtins, ...contributed];
}

/** Find a workspace-tier interface by id among built-ins and contributions. */
export function findWorkspaceInterface(
	id: string,
	contributed: readonly InterfaceDescriptor[]
): InterfaceDescriptor | undefined {
	const descriptor =
		BUILTIN_INTERFACES.find((entry) => entry.id === id) ??
		contributed.find((entry) => entry.id === id);
	return descriptor && interfaceTier(descriptor.renderer) === "workspace"
		? descriptor
		: undefined;
}

export interface ResolveActiveInterfaceInput {
	contributed: readonly InterfaceDescriptor[];
	/** The effective product mode, after the Console access gate. */
	productMode: ProductMode;
	/** The remembered workspace interface id. */
	workspaceInterfaceId: string;
	/** Whether interfaces beyond the OS desktop are rolled out. */
	workspaceInterfaces: boolean;
}

/**
 * The interface the shell renders. Bot and Console map to their built-ins. In
 * the workspace the remembered interface wins only while it still resolves to a
 * built-in or a currently contributed entry, so disabling or uninstalling a
 * plugin falls back to the OS desktop without rewriting the stored choice.
 * The same holds while the other workspace interfaces are not rolled out: the
 * OS desktop renders, and the remembered choice returns with the flag.
 */
export function resolveActiveInterface({
	contributed,
	productMode,
	workspaceInterfaceId,
	workspaceInterfaces,
}: ResolveActiveInterfaceInput): InterfaceDescriptor {
	if (productMode === "bot") {
		return BOT_INTERFACE;
	}
	if (productMode === "console") {
		return CONSOLE_INTERFACE;
	}
	const remembered = findWorkspaceInterface(workspaceInterfaceId, contributed);
	if (!remembered || (isBeyondOs(remembered) && !workspaceInterfaces)) {
		return OS_INTERFACE;
	}
	return remembered;
}

/**
 * The workspace interface to start with. An explicit startup realm is the
 * user's stated choice for launch, so a remembered workspace interface only
 * applies when the realm is "last used".
 */
export function initialWorkspaceInterfaceId(
	startupRealm: StartupRealm,
	storedId: string | null
): string {
	if (startupRealm !== "last-used" || !storedId) {
		return DEFAULT_WORKSPACE_INTERFACE_ID;
	}
	return storedId;
}

const NO_PROVISIONAL_INTERFACES: InterfaceDescriptor[] = [];

/**
 * Stand-ins for a remembered Marketplace interface while the contributions
 * query is still in flight. Cached per id so the list identity is stable.
 */
const pendingLists = new Map<string, InterfaceDescriptor[]>();
const pendingDescriptors = new WeakSet<InterfaceDescriptor>();

/**
 * True for the placeholder {@link provisionalInterfaces} returns: the shell
 * keeps the interface surface mounted (instead of flashing the OS desktop)
 * and shows a loading state until the real descriptor arrives.
 */
export function isPendingInterface(descriptor: InterfaceDescriptor): boolean {
	return pendingDescriptors.has(descriptor);
}

/**
 * While the first contributions fetch for a node has not landed, an empty list
 * is not authoritative. A remembered Marketplace id then resolves to a pending
 * placeholder rather than falling back to the OS desktop; once the query
 * settles (with data or an error), the real list decides.
 */
export function provisionalInterfaces(
	pending: boolean,
	workspaceInterfaceId: string
): InterfaceDescriptor[] {
	if (
		!(pending && isInterfaceId(workspaceInterfaceId)) ||
		BUILTIN_INTERFACES.some((entry) => entry.id === workspaceInterfaceId)
	) {
		return NO_PROVISIONAL_INTERFACES;
	}
	const cached = pendingLists.get(workspaceInterfaceId);
	if (cached) {
		return cached;
	}
	const placeholder: InterfaceDescriptor = {
		description: "",
		id: workspaceInterfaceId,
		label: "",
		origin: "marketplace",
		params: {},
		// Any non-OS workspace renderer keeps the interface surface mounted; the
		// surface renders a loading state for pending descriptors, never this.
		renderer: "channels",
	};
	pendingDescriptors.add(placeholder);
	const list = [placeholder];
	pendingLists.set(workspaceInterfaceId, list);
	return list;
}

import { describe, expect, test } from "bun:test";
import {
	builtinInterfaceId,
	type InterfaceDescriptor,
	parseInterfaceContributions,
} from "@ryuhq/protocol/interfaces";
import {
	availableInterfaces,
	BUILTIN_INTERFACES,
	DEFAULT_WORKSPACE_INTERFACE_ID,
	initialWorkspaceInterfaceId,
	interfaceCredit,
	isPendingInterface,
	provisionalInterfaces,
	resolveActiveInterface,
} from "./registry.ts";

const [pixelTown] = parseInterfaceContributions([
	{
		description: "A cozy pixel town",
		id: "@example/towns:pixel",
		label: "Pixel Town",
		params: { theme: "night" },
		plugin: "@example/towns",
		renderer: "world-2d",
	},
]);
if (!pixelTown) {
	throw new Error("fixture contribution failed to parse");
}

/** The layout interfaces that follow the worlds in switcher order. */
const LAYOUTS = [
	"Board",
	"Inbox",
	"Graph",
	"Timeline",
	"Messenger",
	"Terminal",
	"Arena",
	"Desk",
	"Card Table",
	"Sheet",
	"Canvas",
	"Calendar",
	"Notebook",
	"Mission Control",
	"Ticker",
	"Focus",
	"Aquarium",
	"Planets",
	"Stream",
	"Forum",
	"Live",
	"Posts",
	"Community",
	"Wiki",
	"Dashboard",
	"Mind Map",
	"Gallery",
	"Newspaper",
	"Q&A",
	"Cinema",
	"Noticeboard",
	"Mail",
	"Status",
	"Records",
	"Path",
	"Glance",
	"Hub",
	"Library",
	"Tickets",
	"Persona",
	"Panels",
	"Departures",
	"Tracking",
	"Flow",
	"Moments",
	"Kitchen",
	"Market",
	"Workers",
	"Arcade",
	"Farm",
	"Town",
	"Rides",
	"Journal",
	"Passport",
	"Lobby",
	"Seasonal",
	"Bank",
	"Quiz Show",
	"Jobs",
	"Knowledge",
	"Hologram",
	"Warehouse",
];

const labels = (list: readonly InterfaceDescriptor[]) =>
	list.map((descriptor) => descriptor.label);

describe("built-in interfaces", () => {
	test("cover every host renderer with ryu ids in switcher order", () => {
		expect(labels(BUILTIN_INTERFACES)).toEqual([
			"Bot",
			"OS",
			"Agent",
			"Channels",
			"Feed",
			"World 2D",
			"World 3D",
			...LAYOUTS,
		]);
		for (const descriptor of BUILTIN_INTERFACES) {
			expect(descriptor.id).toBe(builtinInterfaceId(descriptor.renderer));
			expect(descriptor.origin).toBe("builtin");
		}
	});

	test("keep the existing Bot, OS, and Console descriptions", () => {
		expect(BUILTIN_INTERFACES.slice(0, 3).map((d) => d.description)).toEqual([
			"Managed chat, ready to use",
			"Dock, windows, and App Launcher for Ryu Apps",
			"Configure nodes, models, and organization controls",
		]);
	});
});

describe("availableInterfaces", () => {
	test("offers only Bot without workspace or Console access", () => {
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: false,
					canSwitchToOs: false,
					contributed: [pixelTown],
					workspaceInterfaces: true,
				})
			)
		).toEqual(["Bot"]);
	});

	test("gates Console separately from the workspace interfaces", () => {
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: true,
					canSwitchToOs: false,
					contributed: [pixelTown],
					workspaceInterfaces: true,
				})
			)
		).toEqual(["Bot", "Agent"]);
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: false,
					canSwitchToOs: true,
					contributed: [],
					workspaceInterfaces: true,
				})
			)
		).toEqual([
			"Bot",
			"OS",
			"Channels",
			"Feed",
			"World 2D",
			"World 3D",
			...LAYOUTS,
		]);
	});

	test("holds OS behind its flag, and every other workspace interface behind the next", () => {
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: true,
					canSwitchToOs: false,
					contributed: [pixelTown],
					workspaceInterfaces: true,
				})
			)
		).toEqual(["Bot", "Agent"]);
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: true,
					canSwitchToOs: true,
					contributed: [pixelTown],
					workspaceInterfaces: false,
				})
			)
		).toEqual(["Bot", "OS", "Agent"]);
	});

	test("lists Marketplace interfaces after the built-ins", () => {
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: true,
					canSwitchToOs: true,
					contributed: [pixelTown],
					workspaceInterfaces: true,
				})
			)
		).toEqual([
			"Bot",
			"OS",
			"Agent",
			"Channels",
			"Feed",
			"World 2D",
			"World 3D",
			...LAYOUTS,
			"Pixel Town",
		]);
	});

	test("never lets a contribution surface a host-only shell", () => {
		const forged: InterfaceDescriptor = {
			...pixelTown,
			id: "@example/towns:admin",
			label: "Forged Console",
			renderer: "console",
		};
		expect(
			labels(
				availableInterfaces({
					canSwitchToConsole: true,
					canSwitchToOs: true,
					contributed: [forged],
					workspaceInterfaces: true,
				})
			)
		).not.toContain("Forged Console");
	});

	test("never lists a contribution that reuses a built-in id", () => {
		const shadow: InterfaceDescriptor = {
			...pixelTown,
			id: builtinInterfaceId("feed"),
			label: "Shadow Feed",
			renderer: "feed",
		};
		const listed = availableInterfaces({
			canSwitchToConsole: false,
			canSwitchToOs: true,
			contributed: [shadow],
			workspaceInterfaces: true,
		});
		expect(labels(listed)).not.toContain("Shadow Feed");
		expect(
			listed.filter((descriptor) => descriptor.id === shadow.id)
		).toHaveLength(1);
	});
});

describe("resolveActiveInterface", () => {
	test("maps Bot and Console to their built-ins regardless of the stored id", () => {
		expect(
			resolveActiveInterface({
				contributed: [],
				productMode: "bot",
				workspaceInterfaceId: builtinInterfaceId("channels"),
				workspaceInterfaces: true,
			}).id
		).toBe("ryu:bot");
		expect(
			resolveActiveInterface({
				contributed: [],
				productMode: "console",
				workspaceInterfaceId: builtinInterfaceId("feed"),
				workspaceInterfaces: true,
			}).id
		).toBe("ryu:console");
	});

	test("uses the stored built-in or contributed workspace interface", () => {
		expect(
			resolveActiveInterface({
				contributed: [],
				productMode: "os",
				workspaceInterfaceId: "ryu:world-3d",
				workspaceInterfaces: true,
			}).label
		).toBe("World 3D");
		expect(
			resolveActiveInterface({
				contributed: [pixelTown],
				productMode: "os",
				workspaceInterfaceId: pixelTown.id,
				workspaceInterfaces: true,
			})
		).toBe(pixelTown);
	});

	test("falls back to OS when the plugin is gone or the id is not a workspace interface", () => {
		for (const workspaceInterfaceId of [
			pixelTown.id,
			"ryu:bot",
			"ryu:console",
			"ryu:unknown",
		]) {
			expect(
				resolveActiveInterface({
					contributed: [],
					productMode: "os",
					workspaceInterfaceId,
					workspaceInterfaces: true,
				}).id
			).toBe("ryu:os");
		}
	});
});

describe("resolveActiveInterface with workspace interfaces held back", () => {
	test("renders the OS desktop and keeps the remembered choice for later", () => {
		for (const [workspaceInterfaceId, contributed] of [
			["ryu:world-3d", []],
			[pixelTown.id, [pixelTown]],
		] as const) {
			expect(
				resolveActiveInterface({
					contributed,
					productMode: "os",
					workspaceInterfaceId,
					workspaceInterfaces: false,
				}).id
			).toBe("ryu:os");
		}
	});
});

describe("initialWorkspaceInterfaceId", () => {
	test("restores the remembered interface only for the last-used realm", () => {
		expect(initialWorkspaceInterfaceId("last-used", "ryu:feed")).toBe(
			"ryu:feed"
		);
		expect(initialWorkspaceInterfaceId("last-used", null)).toBe(
			DEFAULT_WORKSPACE_INTERFACE_ID
		);
	});

	test("an explicit startup realm starts the workspace on OS", () => {
		for (const realm of ["os", "bot", "console"] as const) {
			expect(initialWorkspaceInterfaceId(realm, "ryu:feed")).toBe("ryu:os");
		}
	});
});

describe("provisionalInterfaces", () => {
	test("holds a remembered Marketplace interface while contributions load", () => {
		const pending = provisionalInterfaces(true, pixelTown.id);
		expect(pending).toHaveLength(1);
		const [placeholder] = pending;
		if (!placeholder) {
			throw new Error("expected a pending placeholder");
		}
		expect(isPendingInterface(placeholder)).toBe(true);
		expect(provisionalInterfaces(true, pixelTown.id)).toBe(pending);
		const active = resolveActiveInterface({
			contributed: pending,
			productMode: "os",
			workspaceInterfaceId: pixelTown.id,
			workspaceInterfaces: true,
		});
		expect(active.renderer).not.toBe("os");
		expect(isPendingInterface(active)).toBe(true);
		expect(isPendingInterface(pixelTown)).toBe(false);
	});

	test("adds nothing once settled or for a built-in choice", () => {
		expect(provisionalInterfaces(false, pixelTown.id)).toEqual([]);
		expect(provisionalInterfaces(true, builtinInterfaceId("feed"))).toEqual([]);
		expect(provisionalInterfaces(true, "not an id")).toEqual([]);
	});
});

describe("interfaceCredit", () => {
	test("credits Marketplace interfaces, including ones on the OS renderer", () => {
		if (!pixelTown) {
			throw new Error("fixture did not parse");
		}
		expect(interfaceCredit(pixelTown)).toBe("@example/towns");
		expect(
			interfaceCredit({
				...pixelTown,
				attribution: "Acme Studio",
				renderer: "os",
			})
		).toBe("Acme Studio");
		for (const builtin of BUILTIN_INTERFACES) {
			expect(interfaceCredit(builtin)).toBeNull();
		}
	});
});

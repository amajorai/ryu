import type {
	ProductAvailabilityRow,
	ProductProfile,
	ProductSource,
} from "./profile-types.ts";

/**
 * Preview profiles for the surfaces beyond the desktop window: Island, Mobile
 * and Devices. Registered by ./profiles-preview.ts (unit preview), which keeps
 * the stub's exports; split out so each file stays small.
 *
 * None of these ship yet. "Available today" lists only what a visitor can do
 * now; "Planned" rows describe what the docs say the surface will do (the
 * Island page "describes the companion as it will work once it ships"; the
 * roadmap lists Mobile and Hardware as "in flight" and "not release
 * commitments", and each item quotes the page that describes it). Availability
 * rows are therefore "planned" everywhere. Devices has no "Not planned" column.
 */

const DOCS = "apps/fumadocs/content/docs";
const ISLAND_DOC = `${DOCS}/surfaces/island.mdx`;
const MOBILE_DOC = `${DOCS}/mobile/index.mdx`;
const MOBILE_LAYOUT_DOC = `${DOCS}/mobile/devices-and-layout.mdx`;
const ROADMAP_DOC = `${DOCS}/roadmap/index.mdx`;
const HARDWARE_DOC = `${DOCS}/hardware/index.mdx`;
const DEVICES_DOC = `${DOCS}/hardware/devices.mdx`;
const DEVICES_CATALOG =
	"packages/blocks/src/web/data/catalog/desktop-devices.tsx";

/** The catalog FAQ line every coming-soon surface answers "Can I use it?" with. */
const EARLY_ACCESS_FAQ: ProductSource = {
	path: DEVICES_CATALOG,
	quote: "Join early access to hear when it ships.",
};

/** Roadmap: the in-flight pages describe today's build, not a promise. */
const ROADMAP_CURRENT_BUILD: ProductSource = {
	path: ROADMAP_DOC,
	quote:
		"The linked pages describe the current implementation, not a promise that a surface is production-ready.",
};

const ISLAND_AVAILABILITY: readonly ProductAvailabilityRow[] = [
	{
		platform: "macOS",
		state: "planned",
		note: "Notch mode can attach it to the camera notch on a supported Mac.",
		source: {
			path: ISLAND_DOC,
			quote:
				"Notch mode attaches the companion to the camera notch on a supported Mac.",
		},
	},
	{
		platform: "Windows",
		state: "planned",
		note: "Hide on fullscreen apps works on Windows only.",
		source: {
			path: ISLAND_DOC,
			quote: "**Hide on fullscreen apps** is available on Windows only.",
		},
	},
	{
		platform: "Linux",
		state: "planned",
		note: "The Translucent background needs an X11 compositor.",
		source: {
			path: ISLAND_DOC,
			quote: "On Linux, Translucent needs an X11 compositor",
		},
	},
];

export const ISLAND_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Connects to",
			value: "The same Core as Ryu Desktop",
			source: {
				path: ISLAND_DOC,
				quote:
					"It talks to the same Core as the desktop app, so it shares your conversations, agents, and Gateway routing.",
			},
		},
		{
			label: "Screen context",
			value: "Off until you turn it on",
			source: {
				path: ISLAND_DOC,
				quote: "Screen context and proactive suggestions start off",
			},
		},
		{
			label: "Read-back voice",
			value: "Kokoro 82M, on by default",
			source: {
				path: ISLAND_DOC,
				quote: "It is on by default, uses Kokoro 82M",
			},
		},
		{
			label: "Settings",
			value: "Gateway settings, Apps, Island",
			source: {
				path: ISLAND_DOC,
				quote:
					"its node-scoped settings are under **Gateway settings → Apps → Island**",
			},
		},
	],
	status: {
		today: [
			{
				text: "Join early access to hear when it ships.",
				source: EARLY_ACCESS_FAQ,
			},
			{
				text: "Read how the companion will work, ahead of its release.",
				source: {
					path: ISLAND_DOC,
					quote:
						"This page describes the companion as it will work once it ships.",
				},
			},
		],
		planned: [
			{
				text: "An optional app you install from the Store.",
				source: {
					path: ISLAND_DOC,
					quote:
						"Once it ships, you install it from the Store; it is not installed automatically.",
				},
			},
			{
				text: "System-wide dictation that types speech into the app you are using.",
				source: {
					path: ISLAND_DOC,
					quote: "types speech into the focused app",
				},
			},
			{
				text: "Generated screens: an agent's interactive answer in a floating window.",
				source: {
					path: ISLAND_DOC,
					quote:
						"**Generated screens** show an agent's interactive answer in a floating window.",
				},
			},
		],
		notPlanned: [
			{
				text: "An AI of its own. Every model call goes to your own Ryu server.",
				source: {
					path: DEVICES_CATALOG,
					quote: "No. Every model call goes to your own Ryu server",
				},
			},
			{
				text: "Installing itself. Island is never added automatically.",
				source: {
					path: ISLAND_DOC,
					quote: "it is not installed automatically",
				},
			},
		],
	},
	availability: ISLAND_AVAILABILITY,
	docs: [
		{
			label: "Island",
			path: "/docs/surfaces/island",
			description: "Settings, privacy, voice, and generated screens.",
		},
		{ label: "Built-in tools", path: "/docs/core/built-in-tools" },
		{ label: "Surfaces", path: "/docs/surfaces" },
	],
};

/** Both the watch and the car screens reach agents the same way. */
const WATCH_AND_CAR: ProductSource = {
	path: MOBILE_DOC,
	quote:
		"The watch and car screens reach your agents through Ryu on the phone, and only on a remote node.",
};

const MOBILE_AVAILABILITY: readonly ProductAvailabilityRow[] = [
	{
		platform: "iPhone and iPad",
		state: "planned",
		note: "Uses Apple's Liquid Glass design on iOS 26 and later.",
		source: {
			path: MOBILE_LAYOUT_DOC,
			quote: "On iOS 26 and later, Ryu uses Apple's Liquid Glass design",
		},
	},
	{
		platform: "Android",
		state: "planned",
		note: "One app whose layout follows the window, from phones to foldables.",
		source: {
			path: MOBILE_LAYOUT_DOC,
			quote: "The same Ryu Mobile app adapts to the window it runs in.",
		},
	},
	{
		platform: "On-device model",
		state: "planned",
		note: "Runs a model downloaded to the phone, without a node.",
		source: {
			path: MOBILE_DOC,
			quote: "run a GGUF model downloaded to the phone through `llama.rn`",
		},
	},
	{
		platform: "Watch",
		state: "planned",
		note: "Reaches your agents through the phone, on a remote node only.",
		source: WATCH_AND_CAR,
	},
	{
		platform: "CarPlay and Android Auto",
		state: "planned",
		note: "Reaches your agents through the phone, on a remote node only.",
		source: WATCH_AND_CAR,
	},
	{
		platform: "Ryu keyboard on iOS",
		state: "planned",
		note: "Sends AI actions straight to the node you choose for it.",
		source: {
			path: MOBILE_DOC,
			quote:
				"The iOS keyboard sends AI actions straight to the node you chose for it.",
		},
	},
];

export const MOBILE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "App stores",
			value: "Not listed yet",
			source: {
				path: DEVICES_CATALOG,
				quote: "Not yet. Ryu Mobile is not in the app stores.",
			},
		},
		{
			label: "Platforms",
			value: "iOS and Android",
			source: {
				path: MOBILE_DOC,
				quote: "Ryu Mobile is the full Ryu app for iOS and Android.",
			},
		},
		{
			label: "Connect a node",
			value: "Scan its QR code, or paste a link",
			source: {
				path: `${DOCS}/mobile/connect-and-sign-in.mdx`,
				quote: "Scan the Ryu connect QR code that the node shows.",
			},
		},
		{
			label: "Model format",
			value: "GGUF, on the phone",
			source: {
				path: MOBILE_DOC,
				quote: "run a GGUF model downloaded to the phone",
			},
		},
		{
			label: "Screens",
			value: "Phones, tablets, foldables, Android TV",
			source: {
				path: MOBILE_LAYOUT_DOC,
				quote:
					"How Ryu Mobile adapts to phones, tablets, foldables, Chromebooks, Android TV, and Macs",
			},
		},
	],
	status: {
		today: [
			{
				text: "Join early access to hear when it ships.",
				source: EARLY_ACCESS_FAQ,
			},
			{
				text: "Read the Mobile docs, which describe the current build.",
				source: ROADMAP_CURRENT_BUILD,
			},
		],
		planned: [
			{
				text: "The same navigation and names as Ryu Desktop.",
				source: {
					path: MOBILE_DOC,
					quote: "Mobile uses the same navigation and names as Desktop.",
				},
			},
			{
				text: "A Supported on Mobile label on each app and plugin.",
				source: {
					path: MOBILE_DOC,
					quote:
						'A "Supported on Mobile" label on an app or plugin shows the support level that the app or plugin declares for Mobile.',
				},
			},
		],
	},
	availability: MOBILE_AVAILABILITY,
	docs: [
		{
			label: "Mobile",
			path: "/docs/mobile",
			description: "Nodes, on-device models, and phone features.",
		},
		{ label: "Connect and sign in", path: "/docs/mobile/connect-and-sign-in" },
		{ label: "On-device models", path: "/docs/mobile/models" },
		{ label: "Watch and car", path: "/docs/mobile/watch-and-car" },
		{ label: "AI keyboard", path: "/docs/mobile/ai-keyboard" },
	],
	related: [
		{ label: "Roadmap", href: "/docs/roadmap", kind: "docs" },
		{
			label: "Offline AI assistants: readiness and hardware checklist",
			href: "/blog/best-on-device-offline-ai-assistants",
			kind: "blog",
		},
	],
};

const DEVICES_AVAILABILITY: readonly ProductAvailabilityRow[] = [
	{
		platform: "Watch",
		state: "planned",
		note: "A small round color screen, for chat when you ask.",
		source: {
			path: DEVICES_DOC,
			quote:
				"A wrist device with a small round color display for on-demand chat.",
		},
	},
	{
		platform: "Necklace",
		state: "planned",
		note: "Audio first, with no screen. Built to be the always-on ambient device.",
		source: {
			path: DEVICES_DOC,
			quote:
				"An audio-first pendant with no display, designed to be the primary 24/7 ambient memory device.",
		},
	},
	{
		platform: "Desk hub",
		state: "planned",
		note: "Always plugged in, with an e-ink panel for glanceable information.",
		source: {
			path: DEVICES_DOC,
			quote:
				"An always-on, always-plugged desk panel built around e-ink for glanceable information.",
		},
	},
];

export const DEVICES_PROFILE: ProductProfile = {
	facts: [
		{
			label: "For sale",
			value: "Not yet, still in development",
			source: {
				path: DEVICES_CATALOG,
				quote:
					"Not yet. The devices are still in development and have not finished hardware testing.",
			},
		},
		{
			label: "Chip",
			value: "ESP32-S3 in all three",
			source: {
				path: DEVICES_DOC,
				quote: "All three are ESP32-S3 thin clients.",
			},
		},
		{
			label: "On-device inference",
			value: "None. Your node does the work.",
			source: {
				path: HARDWARE_DOC,
				quote: "It runs **no inference of its own**.",
			},
		},
		{
			label: "Link to your node",
			value: "Direct Wi-Fi or a phone relay",
			source: {
				path: HARDWARE_DOC,
				quote:
					"A device reaches the node over direct WiFi or through a phone relay, and both paths carry the same encrypted protocol.",
			},
		},
		{
			label: "Audio stream",
			value: "Opus, about 16 kbit/s",
			source: {
				path: DEVICES_DOC,
				quote: "The firmware streams Opus at a low bitrate (about 16 kbit/s",
			},
		},
	],
	status: {
		today: [
			{
				text: "Firmware source with build and flash steps, for first bring-up.",
				source: {
					path: HARDWARE_DOC,
					quote:
						"The firmware ships as ESP-IDF source with build and flash steps.",
				},
			},
			{
				text: "Core's device connection, pairing, and chat turns, covered by software tests.",
				source: {
					path: HARDWARE_DOC,
					quote:
						"The Core WebSocket, registry, pairing, and turn path are covered by software tests",
				},
			},
		],
		planned: [
			{
				text: "Hardware testing on the physical watch, necklace, and desk boards.",
				source: {
					path: HARDWARE_DOC,
					quote:
						"the physical watch, necklace, and desk boards have not completed hardware-in-the-loop testing",
				},
			},
			{
				text: "A settled hardware design. The roadmap lists Hardware as in flight, with its design still changing.",
				source: {
					path: ROADMAP_DOC,
					quote:
						"A surface is listed here while its product shape, support boundary, or hardware design is still changing.",
				},
			},
		],
	},
	availability: DEVICES_AVAILABILITY,
	docs: [
		{
			label: "Hardware",
			path: "/docs/hardware",
			description: "How the devices reach your node.",
		},
		{ label: "Hardware devices", path: "/docs/hardware/devices" },
		{ label: "Pairing", path: "/docs/hardware/pairing" },
		{ label: "Firmware", path: "/docs/hardware/firmware" },
		{ label: "Hardware security", path: "/docs/hardware/security" },
	],
	related: [{ label: "Roadmap", href: "/docs/roadmap", kind: "docs" }],
};

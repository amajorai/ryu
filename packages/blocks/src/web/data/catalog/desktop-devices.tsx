import { Chrome, Gem, Monitor, Radio, Smartphone } from "lucide-react";
import {
	DiffReviewVisual,
	IslandConsentVisual,
	MockCard,
} from "../../product-row-visuals.tsx";
import {
	ChromeVisual,
	DesktopVisual,
	DevicesVisual,
	IslandVisual,
	MobileVisual,
} from "../../visuals.tsx";
import type { Product } from "../product-types.ts";
import {
	BOOK_DEMO,
	DeviceLinkVisual,
	DOWNLOAD,
	EARLY_ACCESS,
	MobileSyncVisual,
	readTheDocs,
	TabConsentVisual,
} from "./shared.tsx";

/** Desktop, Island, Mobile, Chrome and Devices, in catalogue order (see `../products.tsx`). */
export const DESKTOP_TO_DEVICES: Product[] = [
	{
		slug: "desktop",
		name: "Ryu Desktop",
		navLabel: "Desktop",
		category: "Workspaces",
		tagline: "Run Ryu agents from your desktop.",
		Icon: Monitor,
		hero: {
			eyebrow: "Ryu Desktop",
			title: "The Ryu app for your computer",
			subtitle:
				"Chat with agents, connect tools, manage models, and review runs in one app.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <DesktopVisual />,
		},
		splits: [
			{
				title: "Use coding agents from the desktop",
				description:
					"Pick a folder and branch, run agents in their own worktrees, then review the diff and apply it or open a PR.",
				visual: (
					<MockCard>
						<DiffReviewVisual />
					</MockCard>
				),
			},
		],
		bento: {
			title: "Everything in one app",
			items: [
				{
					title: "Your models, your keys",
					description: "Use local models, your own keys, or a Ryu plan.",
				},
				{
					title: "Bring your history",
					description:
						"Import Claude Code and Codex threads, plus ChatGPT and Claude exports.",
				},
				{
					title: "Apps and sandbox",
					description:
						"Install Apps from the store and run agent actions in a sandbox.",
				},
			],
		},
		cta: {
			title: "Ready to try Ryu Desktop?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			note: "Every feature is free for 7 days; local chat stays free after.",
		},
	},

	{
		slug: "island",
		name: "Ryu Island",
		navLabel: "Island",
		category: "Workspaces",
		status: "coming-soon",
		tagline: "A screen-aware companion that suggests the next step.",
		Icon: Radio,
		hero: {
			eyebrow: "Ryu Island · Coming soon",
			title: "Help with what's on screen",
			subtitle:
				"Uses on-screen context to suggest your next step, with access you choose.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/surfaces/island"),
			visual: <IslandVisual />,
		},
		splits: [
			{
				title: "You choose what it sees",
				description:
					"Chat is on by default. Screen reading and suggestions ask before they start, and you can turn any of them off.",
				visual: (
					<MockCard>
						<IslandConsentVisual />
					</MockCard>
				),
			},
		],
		bento: {
			title: "What Island is built to do",
			items: [
				{
					title: "Local by default",
					description:
						"Screen context is read on your device; suggestions use a local model by default.",
				},
				{
					// workspaces.md I9: island-state.ts:19-35.
					title: "Out of the way",
					description:
						"A small island that expands only when it has something useful.",
				},
				{
					title: "Mini chat",
					description:
						"Tap for a quick chat with your own agents and tools, or hold to talk.",
				},
			],
		},
		faq: [
			{
				q: "Does Island have its own AI?",
				a: "No. Every model call goes to your own Ryu server, so it uses the same agents, settings, and data-loss checks.",
			},
			{
				q: "Can I use Island today?",
				a: "Not yet. Island is not in the current Ryu release. Join early access to hear when it ships.",
			},
		],
		cta: {
			title: "Ready to hear when Island ships?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/surfaces/island"),
		},
	},

	{
		slug: "mobile",
		name: "Ryu Mobile",
		navLabel: "Mobile",
		category: "Workspaces",
		status: "coming-soon",
		tagline: "Chat with your agents from your phone.",
		Icon: Smartphone,
		hero: {
			eyebrow: "Ryu Mobile · Coming soon",
			title: "Use Ryu on your phone",
			subtitle: "Reach your Ryu server from iPhone and Android.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/mobile"),
			visual: <MobileVisual />,
		},
		// workspaces.md M4.
		splits: [
			{
				title: "Your server or your phone",
				description:
					"Chats on your server appear on every device. Chats with on-device models stay on the phone.",
				visual: <MobileSyncVisual />,
			},
		],
		// workspaces.md M2 (local-model-catalog.ts:7,17), M3 (node-store.ts:5-6).
		bento: {
			title: "Built for your phone",
			items: [
				{
					title: "Small open models",
					description: "Run small open models on the phone, even offline.",
				},
				{
					title: "Picks the best server",
					description:
						"Uses your home or cloud server when reachable, else the phone.",
				},
				{
					title: "Same agents",
					description: "Chat with the agents already on your Ryu server.",
				},
			],
		},
		// workspaces.md W9, M5.
		faq: [
			{
				q: "Can I install it today?",
				a: "Not yet. Ryu Mobile is not in the app stores. Join early access to hear when it ships.",
			},
			{
				q: "Do my Ryu server's rules still apply?",
				a: "Yes. Requests sent to your Ryu server follow the same rules and limits.",
			},
		],
		cta: {
			title: "Ready to hear when Mobile ships?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/mobile"),
		},
	},

	{
		slug: "chrome-extension",
		name: "Ryu for Chrome",
		navLabel: "Chrome",
		category: "Workspaces",
		status: "early-access",
		tagline: "A page-aware companion in your browser.",
		Icon: Chrome,
		hero: {
			eyebrow: "Ryu for Chrome · Early access",
			title: "Ryu in your browser",
			subtitle:
				"Summarize the page, ask about a selection, or save it to Ryu, without leaving the tab.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/browser-extension"),
			visual: <ChromeVisual />,
		},
		// workspaces.md X7; apps/extension/README.md:39.
		splits: [
			{
				title: "Asks before it acts",
				description:
					"It reads the active tab only when you allow it. Page changes, navigation, downloads, and uploads need a one-time approval.",
				visual: <TabConsentVisual />,
			},
		],
		// apps/extension/README.md:7-40; lib/prompt-library.ts; workspaces.md X5.
		bento: {
			title: "Built into Chrome",
			items: [
				{
					title: "New Tab home",
					description: "A smart bar, your recent chats, and an agent picker.",
				},
				{
					title: "Address bar shortcut",
					description:
						"Type “ryu” in the address bar to search, ask, or run a skill.",
				},
				{
					title: "Saved prompts",
					description: "Save prompts to a library and run them on any page.",
				},
			],
		},
		faq: [
			{
				// workspaces.md X5; apps/extension/README.md:35-38.
				q: "Does it work without my Ryu server?",
				a: "Yes, with a private model that runs in the browser.",
			},
			{
				q: "Can I install it today?",
				a: "Not from the Chrome Web Store yet. Join early access to hear when it is listed.",
			},
		],
		cta: {
			title: "Ready to add Ryu to Chrome?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/browser-extension"),
		},
	},

	{
		slug: "devices",
		name: "Ryu Devices",
		navLabel: "Devices",
		category: "Workspaces",
		status: "coming-soon",
		tagline: "A watch, a necklace, and a desk display for your Ryu server.",
		Icon: Gem,
		hero: {
			eyebrow: "Ryu Devices · Coming soon",
			title: "Ryu beyond your computer",
			subtitle:
				// apps/hardware/README.md:11-13.
				"Wearable and desk devices that talk to your own Ryu server.",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/hardware"),
			visual: <DevicesVisual />,
		},
		// apps/hardware/README.md:18-37 (end-to-end encryption needs RHP v1.1 pairing).
		splits: [
			{
				title: "Talks only to your server",
				description:
					"Devices connect over Wi-Fi, or through your phone over Bluetooth. Newly paired devices encrypt the session end to end, so the phone can't read it.",
				visual: <DeviceLinkVisual />,
			},
		],
		// apps/hardware/README.md:11-13 (workspaces.md V3-V5).
		bento: {
			title: "What each device does",
			items: [
				{
					title: "Round-screen watch",
					description:
						"Wake it or press to talk, with a face on its round screen.",
				},
				{
					title: "Screenless necklace",
					description:
						"Captures ambient audio when it hears speech, and chats too.",
				},
				{
					title: "E-ink desk display",
					description:
						"Keeps a rolling ambient summary on e-ink, and chats too.",
				},
			],
		},
		faq: [
			{
				q: "Can I buy one?",
				a: "Not yet. The devices are still in development and have not finished hardware testing.",
			},
			{
				q: "Will they work with my Ryu agents?",
				a: "Yes. They use the same agents, memory, and Gateway rules as the rest of your Ryu server.",
			},
		],
		cta: {
			title: "Ready to hear when Devices ship?",
			subtitle: "",
			primaryCta: EARLY_ACCESS,
			secondaryCta: readTheDocs("/docs/hardware"),
		},
	},
];

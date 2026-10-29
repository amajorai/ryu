import { Box, Bug, Puzzle } from "lucide-react";
import {
	PermissionGrantVisual,
	PluginLifecycleVisual,
} from "../../product-row-visuals.tsx";
import {
	ExtensionsVisual,
	MarketplaceVisual,
	RedTeamVisual,
} from "../../visuals.tsx";
import type { Product } from "../product-types.ts";
import {
	BOOK_DEMO,
	DOWNLOAD,
	MARKETPLACE_DOCS,
	RedTeamTuneVisual,
	readTheDocs,
} from "./shared.tsx";

/** Marketplace, Extensions and Red Teaming, in catalogue order (see `../products.tsx`). */
export const MARKETPLACE_TO_RED_TEAM: Product[] = [
	/* ============================ BUILD (cont.) ===================== */
	{
		slug: "marketplace",
		name: "Marketplace",
		navLabel: "Marketplace",
		category: "Build",
		tagline: "An app store for AI agents. Install agents, tools, and skills.",
		Icon: Box,
		hero: {
			eyebrow: "Marketplace",
			title: "Find apps, skills, and models",
			subtitle: "Browse the catalog and install in one click.",
			primaryCta: DOWNLOAD,
			secondaryCta: readTheDocs(MARKETPLACE_DOCS),
			visual: <MarketplaceVisual />,
		},
		splits: [
			{
				title: "See what an app can reach",
				description:
					"Each app declares what it needs. You grant it at install, the Gateway enforces it, and you can disable the app anytime.",
				cta: { label: "See Extensions", href: "/products/extensions" },
				visual: <PermissionGrantVisual />,
			},
		],
		bento: {
			title: "What's in the Marketplace",
			items: [
				{
					// packages/marketplace/src/catalog/chrome/marketplace-surface.tsx:12.
					title: "Search everything",
					description: "One search box covers the whole marketplace.",
				},
				{
					title: "Preinstalled plugins",
					description:
						"Browsing, crawling, and security plugins come built in.",
				},
				{
					title: "15 kinds of listings",
					description: "Apps, skills, models, workflows, themes, and more.",
				},
			],
		},
		faq: [
			{
				q: "What's in an app?",
				a: "Agents, tools or skills, an optional screen, and the permissions it needs.",
			},
			{
				q: "Can I build my own app?",
				a: "Yes. Build an app with the Ryu SDK and pack it for install.",
			},
		],
		cta: {
			title: "Ready to find your next app?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: readTheDocs(MARKETPLACE_DOCS),
		},
	},

	{
		slug: "extensions",
		name: "Extensions",
		navLabel: "Extensions",
		category: "Build",
		tagline: "Extend Ryu with plugins.",
		Icon: Puzzle,
		hero: {
			eyebrow: "Extensions",
			title: "Extend Ryu with plugins",
			subtitle:
				"Add tools, model providers, and screens to Ryu. Plugins run in open-source Ryu Core.",
			primaryCta: readTheDocs("/docs/extend/develop/extensions"),
			secondaryCta: DOWNLOAD,
			visual: <ExtensionsVisual />,
		},
		splits: [
			{
				title: "Checked at every step",
				description:
					"Ryu checks a plugin's permissions when you install, enable, disable, or update it.",
				visual: <PluginLifecycleVisual />,
			},
		],
		bento: {
			title: "What a plugin can do",
			items: [
				{
					// workspaces.md E4: Desktop is closed source.
					title: "Works with Ryu Desktop",
					description:
						"Plugins run in Core, so they extend Ryu Desktop without changing it.",
				},
				{
					title: "Pack and share",
					description:
						"Build plugins with the Ryu SDK and pack them as installable apps.",
				},
				{
					title: "Companion screens",
					description: "A plugin can ship its own screen alongside its tools.",
				},
			],
		},
		cta: {
			title: "Ready to extend Ryu?",
			subtitle: "",
			primaryCta: readTheDocs("/docs/extend/develop/extensions"),
			secondaryCta: DOWNLOAD,
		},
	},

	/* ========================= PLATFORM (cont.) ===================== */
	{
		slug: "red-team",
		name: "Red Teaming",
		navLabel: "Red Teaming",
		category: "Platform",
		tagline: "Probe your agents for common security failures.",
		Icon: Bug,
		hero: {
			eyebrow: "Red Teaming",
			title: "Test your agents for security failures",
			subtitle:
				"A self-serve tool for Ryu Desktop and the CLI. Run ten built-in probes against each agent and see which ones it withstands.",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
			visual: <RedTeamVisual />,
		},
		splits: [
			{
				title: "Tune your Gateway from results",
				description:
					"Each probe is scored by the Gateway's evaluators. Use the results to tune your firewall and evals.",
				cta: { label: "See Ryu Gateway", href: "/products/gateway" },
				visual: <RedTeamTuneVisual />,
			},
		],
		bento: {
			title: "Test like an attacker",
			items: [
				{
					title: "Injection and leaks",
					description:
						"Direct and indirect injection, plus personal data and system-prompt leaks.",
				},
				{
					title: "Tool abuse",
					description: "Tool misuse, plus SQL and shell injection.",
				},
				{
					title: "Harmful output",
					description: "Jailbreaks, toxic replies, and biased answers.",
				},
			],
		},
		cta: {
			title: "Ready to test your agents?",
			subtitle: "",
			primaryCta: DOWNLOAD,
			secondaryCta: BOOK_DEMO,
		},
	},
];

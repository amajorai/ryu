import type { LucideIcon } from "lucide-react";
import {
	CalendarDays,
	Film,
	Globe2,
	LayoutDashboard,
	PanelsTopLeft,
	Presentation,
	Workflow,
} from "lucide-react";

/**
 * The curated, public projection of Ryu's first-party app surfaces.
 *
 * Names, taglines, IDs, and category labels intentionally mirror the manifests
 * (or Core's compiled Spaces manifest). The richer copy and visual key below
 * describe the job each app helps a visitor understand; they do not replace the
 * manifest or the Marketplace catalog as an install/runtime source of truth.
 */
export type AppShowcaseVisualKey =
	| "calendar"
	| "canvas"
	| "dashboards"
	| "sites"
	| "slides"
	| "spaces"
	| "video-studio";

export interface AppShowcaseFeature {
	description: string;
	title: string;
}

export interface AppShowcase {
	category: string;
	docsPath: string;
	features: readonly AppShowcaseFeature[];
	icon: LucideIcon;
	manifestId: string;
	name: string;
	shortDescription: string;
	slug: AppShowcaseVisualKey;
	surfaceLabel: string;
	tagline: string;
	visual: AppShowcaseVisualKey;
}

export const appShowcases = [
	{
		category: "Developer Tools",
		docsPath: "/docs/apps/sites",
		features: [
			{
				description:
					"Start with a page structure, then let an agent help shape the details without losing the edit surface.",
				title: "Shape pages with context",
			},
			{
				description:
					"Keep drafts private while content, access, and the next version are still being decided.",
				title: "Keep drafts private",
			},
			{
				description:
					"Save versions and publish the selected build when it is ready to leave the workspace.",
				title: "Publish the version you choose",
			},
		],
		icon: Globe2,
		manifestId: "@ryu/sites",
		name: "Sites",
		shortDescription:
			"Create, refine, and deploy websites with private access.",
		slug: "sites",
		surfaceLabel: "Desktop Companion",
		tagline: "Build websites on Ryu",
		visual: "sites",
	},
	{
		category: "Productivity",
		docsPath: "/docs/apps/dashboards",
		features: [
			{
				description:
					"Assemble the widgets that matter to this team, project, or node without turning the board into a report.",
				title: "Compose your view",
			},
			{
				description: "Put monitors and meetings on one live board.",
				title: "See the node at a glance",
			},
			{
				description:
					"Keep live sources and widget health visible so a broken feed is a state to act on, not a silent blank.",
				title: "Know when a source changes",
			},
		],
		icon: LayoutDashboard,
		manifestId: "@ryu/dashboards",
		name: "Dashboards",
		shortDescription: "Put monitors and meetings on one live board.",
		slug: "dashboards",
		surfaceLabel: "Web + Desktop",
		tagline: "Live widget boards over your node",
		visual: "dashboards",
	},
	{
		category: "Creative",
		docsPath: "/docs/apps/video-studio",
		features: [
			{
				description:
					"Place footage, voice, music, stills, and generated media on a timeline you can read at a glance.",
				title: "Cut in layers",
			},
			{
				description:
					"Review storyboards and timed captions in the same production workspace as the edit.",
				title: "Review the story",
			},
			{
				description:
					"Render a finished video on your Ryu node after the edit is ready to leave the timeline.",
				title: "Render the final",
			},
		],
		icon: Film,
		manifestId: "@ryu/video-studio",
		name: "Video Studio",
		shortDescription:
			"Edit layered timelines, review storyboards, add timed captions, and render finished videos.",
		slug: "video-studio",
		surfaceLabel: "Desktop Companion",
		tagline: "From your first cut to the finished film",
		visual: "video-studio",
	},
	{
		category: "Creative",
		docsPath: "/docs/apps/slides",
		features: [
			{
				description:
					"Keep the narrative visible as a strip of frames instead of losing the deck inside a single editor view.",
				title: "See every frame",
			},
			{
				description:
					"Use Ryu media tools to add visuals, then edit the result yourself with familiar layers.",
				title: "Make the visual yours",
			},
			{
				description:
					"Preview the full carousel and export the frames when the sequence reads cleanly.",
				title: "Export the sequence",
			},
		],
		icon: Presentation,
		manifestId: "@ryu/slides",
		name: "Slides",
		shortDescription:
			"Create, arrange, preview, import, and export carousel frames with Ryu's media tools.",
		slug: "slides",
		surfaceLabel: "Web + Desktop",
		tagline: "Keep every frame clear",
		visual: "slides",
	},
	{
		category: "Core",
		docsPath: "/docs/surfaces/desktop/user-guide/spaces-memory",
		features: [
			{
				description:
					"Keep notes, documents, and files together so the source stays close to the work it informs.",
				title: "Store the source",
			},
			{
				description:
					"Search the material you own and follow its structure instead of starting every agent turn from zero.",
				title: "Find the context",
			},
			{
				description:
					"Give agents an explicit Space to read from, so shared knowledge stays scoped and inspectable.",
				title: "Share a source of truth",
			},
		],
		icon: PanelsTopLeft,
		manifestId: "@ryu/spaces",
		name: "Spaces",
		shortDescription:
			"Keep notes, documents, and searchable files in one place.",
		slug: "spaces",
		surfaceLabel: "Core workspace",
		tagline: "Where every note, doc, and file lives",
		visual: "spaces",
	},
	{
		category: "Productivity",
		docsPath: "/docs/apps/calendar",
		features: [
			{
				description:
					"See scheduled work across Month, Week, Day, and Agenda views without switching between agents.",
				title: "See recurring work",
			},
			{
				description:
					"Read upcoming runs and recent outcomes together so the next action has a clear place on the day.",
				title: "Read the next run",
			},
			{
				description:
					"Create or adjust an automation from the same calendar that tells you what is already scheduled.",
				title: "Schedule from the work view",
			},
		],
		icon: CalendarDays,
		manifestId: "@ryu/calendar",
		name: "Calendar",
		shortDescription:
			"See every scheduled agent and workflow run across Month, Week, Day, and Agenda views.",
		slug: "calendar",
		surfaceLabel: "Web + Desktop",
		tagline: "Every scheduled run on one calendar",
		visual: "calendar",
	},
	{
		category: "Creative",
		docsPath: "/docs/apps/canvas",
		features: [
			{
				description:
					"Connect image, video, text, speech, upload, and note nodes into a readable production graph.",
				title: "Wire up media",
			},
			{
				description:
					"Keep sources and transformations visible so the board explains how an output came together.",
				title: "Keep the graph inspectable",
			},
			{
				description:
					"Save each board as a Space document so it stays editable, shareable, and searchable.",
				title: "Save boards in Spaces",
			},
		],
		icon: Workflow,
		manifestId: "@ryu/canvas",
		name: "Canvas",
		shortDescription:
			"Wire media, sourced images, and agents together on a board that stays editable in Spaces.",
		slug: "canvas",
		surfaceLabel: "Web + Desktop",
		tagline: "Wire up media, sourced images, and agents",
		visual: "canvas",
	},
] as const satisfies readonly AppShowcase[];

export function getAppShowcase(slug: string): AppShowcase | undefined {
	return appShowcases.find((app) => app.slug === slug);
}

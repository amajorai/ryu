// Standalone browser story for the REAL store-listing detail shell
// (`@ryu/marketplace/catalog/detail/listing-detail-shell`) — the one layout every
// Store tab's preview dialog now renders inside: hero, action bar, divided stat
// strip, screenshot rail, and a two-column body (content + Information rail).
//
// WHY A STORY. The shell only ever appears inside a `<Dialog>` opened from a
// catalog section, which needs Core (a node, a catalog fetch, a selection). None
// of that is a property of the LAYOUT, and the layout is the thing that regressed:
// the preview was authored for a 26rem side pane that no caller can open any more,
// so a wide dialog rendered one thin column with a gutter of air. Mounting the
// shell directly, at the dialog's real width, is what makes "is it actually two
// columns / does it scroll sideways / does the stat strip divide evenly"
// answerable — and none of those questions can be answered by a type-check.
//
// It mounts the real exported components, never a copy: a story that certifies a
// fork of the layout certifies nothing.

import {
	ListingAsideCard,
	ListingDetailShell,
	ListingGalleryRail,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { SupportExtensionPanel } from "@ryu/marketplace/catalog/detail/support-extension-panel";
import type {
	CatalogEntry,
	PluginCatalogDetail,
} from "@ryu/marketplace/catalog/types";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

/** The dialog geometry from `StoreCatalogLayout` / `MarketplaceDetailDialog`,
 *  reproduced exactly. Not imported, because both call sites bake it into a
 *  `<DialogContent>` that would need a Dialog root and a portal — and the number
 *  is the thing under test, so it is spelled out here rather than trusted. */
const DIALOG_CLASS =
	"mx-auto max-h-[88vh] w-[min(80rem,94vw)] overflow-y-auto overflow-x-hidden rounded-xl border bg-background shadow-lg";
const LISTING_SCREENSHOT = "http://127.0.0.1:5198/assets/images/ui-system.png";

/** A deliberately LONG value set. A layout that only survives short strings is
 *  what produced the early-wrapping preview in the first place. */
const INFO_ROWS = [
	{ label: "Developer", value: "Ryu Systems, Inc." },
	{ label: "Category", value: "Productivity" },
	{ label: "Version", value: "2026.7.1-1" },
	{ label: "License", value: "Apache-2.0" },
	{ label: "Repository", value: "github.com/amajorai/ryu-marketplace" },
	{ label: "Website", value: "https://example.com/a-fairly-long-path/page" },
	{ label: "Privacy Policy", value: "https://example.com/privacy" },
	{ label: "Terms of Service", value: "https://example.com/terms" },
];

const SUPPORT_ENTRY: CatalogEntry = {
	description: "A browser session and shared shell companion.",
	id: "@ryu/browser",
	kinds: ["tool"],
	name: "Browser",
	surface_support: [
		{ surface: "desktop", support: "full" },
		{ inheritedFrom: "desktop", surface: "mobile", support: "limited" },
		{ inheritedFrom: "desktop", surface: "web", support: "full" },
		{
			inheritedFrom: "desktop",
			surface: "extension",
			support: "limited",
		},
	],
	tags: ["browser", "shell"],
	version: "1.0.0",
};

const SUPPORT_DETAIL: PluginCatalogDetail = {
	apiSurface: {
		provides: [{ capability: "browser.control" }],
		runnables: [
			{ id: "browser-tool", kind: "tool", name: "Browser tools" },
			{ id: "browser-companion", kind: "companion", name: "Browser panel" },
		],
		sidecars: [{ name: "browser", routes: [] }],
		triggers: { turnHooks: [] },
	},
	extensions: [
		{
			features: ["Browser control (browser.control)"],
			label: "Browser",
			target: "browser",
		},
		{
			features: ["dock panels"],
			label: "Shared Ryu shell",
			target: "ryu-shell",
		},
	],
	implementation: [
		{
			features: ["tool runnable", "capability broker"],
			label: "Core runtime",
			layer: "core",
		},
		{
			features: ["companion UI", "dock panels"],
			label: "Shared Ryu shell",
			layer: "shared-shell",
		},
		{
			features: ["browser process"],
			label: "Package sidecar",
			layer: "sidecar",
		},
	],
	surfaceSupport: SUPPORT_ENTRY.surface_support,
};

function Story() {
	return (
		<div className="min-h-svh bg-muted/40 p-8">
			<div className={DIALOG_CLASS} data-testid="dialog">
				<ListingDetailShell
					// SECONDARY controls only. The primary CTA moved into the hero's
					// title row (see `hero.actions` below) and this band is what did not
					// fit up there: Settings, and the price/installed pills. Mirroring
					// the real `AppSecondaryActions` split matters — a story that keeps
					// the old arrangement is a picture of a layout that no longer ships.
					actions={
						<>
							<Button size="sm" variant="ghost">
								Settings
							</Button>
							<span
								className="ml-auto flex shrink-0 items-center gap-2"
								data-testid="status"
							>
								<Badge variant="secondary">Added</Badge>
							</span>
						</>
					}
					aside={
						<>
							<ListingAsideCard title="Information">
								<ListingInfoGrid rows={INFO_ROWS} />
							</ListingAsideCard>
							<ListingAsideCard title="Tags">
								<div className="flex flex-wrap gap-1">
									{["browser", "automation", "headless", "chromium"].map(
										(tag) => (
											<Badge key={tag} typography="normal" variant="outline">
												{tag}
											</Badge>
										)
									)}
								</div>
							</ListingAsideCard>
							<ListingAsideCard title="Keywords">
								<p className="text-muted-foreground text-xs leading-relaxed">
									browser, automation, headless, chromium, remote desktop
								</p>
							</ListingAsideCard>
							<ListingAsideCard title="Capabilities">
								<div className="flex flex-col gap-2 text-xs">
									<div className="flex items-center justify-between gap-3">
										<span className="font-medium">Browser control</span>
										<Badge variant="secondary">Browser toolkit</Badge>
									</div>
									<p className="text-muted-foreground">
										Remote browser navigation, snapshots, and screenshots.
									</p>
								</div>
							</ListingAsideCard>
							<ListingAsideCard title="Example prompts">
								<ul className="flex flex-col gap-2 text-muted-foreground text-xs">
									<li>“Open the product dashboard and summarize it.”</li>
									<li>“Take a screenshot of the checkout flow.”</li>
								</ul>
							</ListingAsideCard>
						</>
					}
					gallery={
						<ListingGalleryRail
							name="Example App"
							// The bundled asset keeps the gallery visible in the proof while
							// exercising the same http(s)-only URL guard as a GitHub image.
							screenshots={[1, 2, 3, 4, 5].map(
								(n) => `${LISTING_SCREENSHOT}?shot=${n}`
							)}
						/>
					}
					hero={
						<ListingHero
							// The PRIMARY control, on the title's row and on the wash — the
							// arrangement the real Apps section ships. `secondary` + a ring
							// rather than the `ghost`/`outline` variants the band used: a
							// button with no fill dissolves into an author-supplied dither.
							actions={
								<>
									{/* The PRIMARY variant, matching the real InstallButton's
									    `idleVariant="default"`. A saturated brand fill is the one
									    thing that reads on any author-supplied wash in either
									    theme — `secondary` is a near-black plate in dark mode and
									    disappears into the dither, which is exactly the failure
									    the ghost variant had. */}
									<Button size="sm">Add</Button>
									<span className="rounded-full bg-white/15 px-2 py-1 text-white/85 backdrop-blur-sm">
										♥
									</span>
								</>
							}
							// "Built-in" is a STATUS glyph now, not a word in this array, and
							// "COMPANION" is gone entirely — every listing in the Apps tab is
							// one, so the chip said nothing.
							badges={["Required", "TOOL", "Browser toolkit"]}
							banner={{
								colors: ["#0f172a", "#2563eb", "#06b6d4"],
								style: "gradient",
							}}
							dither={{ from: 250, to: "transparent", direction: "down" }}
							icon={
								<span className="font-semibold text-2xl text-white">E</span>
							}
							name="Example App With A Fairly Long Listing Name"
							statusIcons={<StatusBadge kind="builtin" tone="hero" />}
							tagline="Clears your inbox, sends emails, manages your calendar, and checks you in for flights."
						/>
					}
					stats={
						<ListingStatStrip
							items={[
								{
									label: "52 Ratings",
									sub: "★★★★☆",
									value: "4.6",
								},
								{ label: "Health", sub: "88/100", value: "A" },
								{ label: "Version", value: "v2026.7.1-1" },
								{ label: "Category", value: "Productivity" },
								{ label: "Developer", value: "Ryu Systems, Inc." },
								{ label: "Updated", value: "2 weeks ago" },
								{ label: "Downloads", value: "12.4k" },
								{ label: "Runs on", value: "Desktop, Island, Mobile" },
							]}
						/>
					}
				>
					<ListingSection title="About">
						<p className="text-muted-foreground text-sm leading-relaxed">
							{"Lorem ipsum dolor sit amet, ".repeat(24)}
						</p>
					</ListingSection>
					<ListingSection title="Permissions">
						<ul className="flex flex-col gap-1.5">
							{["Read files", "Network access", "Run commands"].map((g) => (
								<li className="rounded-md bg-muted px-3 py-1.5" key={g}>
									<div className="font-medium text-sm">{g}</div>
									<div className="text-muted-foreground text-xs">
										A one-line plain-English description of the grant.
									</div>
								</li>
							))}
						</ul>
					</ListingSection>
					<SupportExtensionPanel
						detail={SUPPORT_DETAIL}
						entry={SUPPORT_ENTRY}
					/>
				</ListingDetailShell>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
document.body.setAttribute("data-harness-ready", "1");

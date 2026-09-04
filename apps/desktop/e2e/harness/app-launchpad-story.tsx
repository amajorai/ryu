// Standalone browser story for the REAL `AppLaunchpadGrid` — the macOS-Launchpad
// grid of app tiles under the composer on the empty chat start page.
//
// Why a browser story rather than a unit test: the whole deliverable is rendered
// geometry — how many columns fit a given width, whether the pages snap whole,
// whether two rows stay two rows. None of that is visible to a type-check, and the
// column count comes from a `ResizeObserver` measurement that only exists in a real
// browser.
//
// Three widths are mounted at once so one screenshot shows the measured page size
// adapting: a narrow split pane, the start page's own 880px column, and a wide one.
// The same item list feeds all three, so the tile art is the control and the layout
// is the variable.

import { createRoot } from "react-dom/client";
import {
	AppLaunchpadGrid,
	type LaunchpadItem,
} from "../../src/components/chat/AppLaunchpad.tsx";
import "../../src/index.css";

/** A realistic spread: apps with a manifest glyph, one with none (which must fall
 *  through to its seeded generative tile rather than a repeated grey square), and
 *  a deliberately long label that has to truncate instead of widening its cell. */
const ITEMS: LaunchpadItem[] = [
	{
		id: "app__browser",
		label: "Browser",
		iconId: "lucide:globe",
		seedId: "@ryu/browser",
	},
	{
		id: "app__crm",
		label: "Harbor",
		iconId: "lucide:contact",
		seedId: "@ryu/crm",
	},
	{
		id: "app__drafts",
		label: "Drafts",
		iconId: "lucide:send",
		seedId: "@ryu/drafts",
	},
	{
		id: "app__blueprint",
		label: "Blueprint",
		iconId: "lucide:workflow",
		seedId: "@ryu/blueprint",
	},
	{
		id: "app__news",
		label: "Wire",
		iconId: "lucide:newspaper",
		seedId: "@ryu/news",
	},
	{
		id: "app__tuition",
		label: "Tuition",
		iconId: "lucide:graduation-cap",
		seedId: "@ryu/tuition",
	},
	{
		id: "app__ugc",
		label: "Campaigns",
		iconId: "lucide:megaphone",
		seedId: "@ryu/ugc",
	},
	{
		id: "app__mission",
		label: "Mission Control",
		iconId: "lucide:radar",
		seedId: "@ryu/mission-control",
	},
	{
		id: "app__reasoning",
		label: "Automated Reasoning",
		seedId: "@ryu/reasoning",
	},
	{
		id: "app__warmup",
		label: "Warmup",
		iconId: "lucide:flame",
		seedId: "@ryu/warmup",
	},
	{
		id: "app__memory",
		label: "Memory",
		iconId: "lucide:brain",
		seedId: "@ryu/memory",
	},
	{
		id: "app__rag",
		label: "Knowledge",
		iconId: "lucide:library",
		seedId: "@ryu/rag",
	},
	{
		id: "app__layers",
		label: "Layers",
		iconId: "lucide:layers",
		seedId: "@ryu/layers",
	},
	{
		id: "app__social",
		label: "Outpost",
		iconId: "lucide:at-sign",
		seedId: "@ryu/social",
	},
	{
		id: "app__store",
		label: "Store",
		iconId: "lucide:shopping-bag",
		seedId: "@ryu/store",
	},
	{
		id: "app__whiteboard",
		label: "Whiteboard",
		iconId: "lucide:pen-tool",
		seedId: "@ryu/whiteboard",
	},
];

/** Records the last launch, so a spec can assert a tile opens the COMPANION path
 *  and that a middle-click asks for a new tab. */
function recordOpen(item: LaunchpadItem, newTab: boolean) {
	const out = document.getElementById("opened");
	if (out) {
		out.textContent = `${item.id} :: ${newTab ? "new-tab" : "same-tab"}`;
	}
}

/** One mount at a fixed width, labelled — the widths stand in for a narrow split
 *  pane, the start page's own column, and a wide window. */
function Pane({ label, width }: { label: string; width: number }) {
	return (
		<section style={{ marginBottom: 40 }}>
			<h2
				style={{
					fontSize: 12,
					marginBottom: 8,
					opacity: 0.6,
					fontFamily: "system-ui, sans-serif",
				}}
			>
				{label} — {width}px
			</h2>
			<div data-testid={`launchpad-${width}`} style={{ width }}>
				<AppLaunchpadGrid items={ITEMS} onOpen={recordOpen} />
			</div>
		</section>
	);
}

function Story() {
	return (
		<div style={{ padding: 40 }}>
			<Pane label="Narrow split pane" width={320} />
			<Pane label="Start page column" width={720} />
			<Pane label="Wide window" width={1040} />
			{/* The empty list must render NOTHING — no stray strip under the
			    composer for a user whose apps are all off. */}
			<section>
				<h2
					style={{
						fontSize: 12,
						marginBottom: 8,
						opacity: 0.6,
						fontFamily: "system-ui, sans-serif",
					}}
				>
					No apps enabled (must render nothing)
				</h2>
				<div data-testid="launchpad-empty" style={{ width: 720 }}>
					<AppLaunchpadGrid items={[]} onOpen={recordOpen} />
				</div>
			</section>
			<pre data-testid="opened" id="opened" />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}

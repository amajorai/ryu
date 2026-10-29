// Standalone browser story for the two settings-chrome changes that only a real
// browser can judge, because both are about what a box looks like:
//
//  1. **The agent banner dialog** (`@ryu/blocks/desktop/agent-banner-dialog`).
//     The REAL dialog, driven by the REAL prefs hook, painting the REAL banner
//     behind it. What needs a browser: the styles are CSS backgrounds and a
//     `<canvas>`, so "did picking Prism actually change the wash" is a computed
//     style, not a prop. A jsdom test can assert a click handler fired; it
//     cannot tell a painted gradient from a painted nothing.
//
//  2. **`bare` settings rows** (`@ryu/blocks/desktop/settings-items`). The bug
//     was a box inside a box: a tall textarea's own border a few pixels inside
//     the settings card's fill. The fix is the absence of a surface, which is
//     only checkable by walking the rendered ancestors of the control and
//     asking whether any of them still paints one. Both a carded row and a bare
//     row are rendered here so the spec compares them against each other rather
//     than against a remembered constant.
//
// The banner pane deliberately uses a fixed agent name and clears that agent's
// stored prefs on load: the dialog writes through to localStorage on every
// click, so without the wipe a rerun would start from the previous run's pick.

import {
	AGENT_BANNER_BASE,
	AgentBannerDialog,
	type AgentBannerPreferenceStore,
	AgentBannerWash,
	AgentProfileBannerFade,
	resolveAgentBanner,
	useAgentBannerPrefs,
} from "@ryu/blocks/desktop/agent-banner-dialog.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	getBundledMarketplaceBackdrops,
	resolveMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { type CSSProperties, useState } from "react";
import { createRoot } from "react-dom/client";
import { installWallpaper } from "../../src/lib/wallpaper-library.ts";
import "../../src/index.css";

/** One agent, so the story is deterministic across runs. */
const bannerBaseStyle: CSSProperties & { "--proof-banner-base": string } = {
	"--proof-banner-base": AGENT_BANNER_BASE,
};

const AGENT = "Banner Story Agent";
const AGENT_ID = "banner-story-agent";
const NODE_PREF_KEY = `proof:node:agent-banner:${AGENT_ID}`;
const MARKETPLACE_WALLPAPERS = getBundledMarketplaceBackdrops();

const nodePreferenceStore: AgentBannerPreferenceStore = {
	get: async () => localStorage.getItem(NODE_PREF_KEY),
	set: async (_agentId, value) => {
		localStorage.setItem(NODE_PREF_KEY, value);
	},
};

try {
	localStorage.removeItem(`ryu:agent-banner:${AGENT}`);
	localStorage.removeItem(NODE_PREF_KEY);
} catch {
	// Storage unavailable: the hook already falls back to the derived default.
}

function BannerPane() {
	const { error, loading, prefs, reset, update } = useAgentBannerPrefs(
		AGENT_ID,
		nodePreferenceStore,
		AGENT
	);
	const banner = resolveAgentBanner(AGENT, prefs);
	const wallpaper = resolveMarketplaceWallpaperSelection(prefs.wallpaper);
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium text-sm">Banner</h2>
			{/* The agent editor's own header shape: the dark slab with the wash over
			    it and the customise trigger parked on top. */}
			<div className="overflow-hidden rounded-lg bg-card">
				<div
					className="bg-(image:--proof-banner-base) relative min-h-48 overflow-hidden"
					data-testid="banner-header"
					style={bannerBaseStyle}
				>
					{wallpaper ? (
						<Backdrop
							className="absolute inset-0"
							definition={wallpaper}
							live={false}
							params={wallpaper.initialParams}
						/>
					) : (
						<AgentBannerWash banner={banner} />
					)}
					<AgentProfileBannerFade />
					<div className="absolute top-3 left-3 z-10">
						<AgentBannerDialog
							agent={AGENT_ID}
							loading={loading}
							marketplaceWallpapers={MARKETPLACE_WALLPAPERS}
							onInstallWallpaper={(wallpaper) => installWallpaper(wallpaper.id)}
							onReset={reset}
							onUpdate={update}
							prefs={prefs}
							storageError={error}
						/>
					</div>
				</div>
				<div className="bg-card p-4" data-testid="banner-body">
					<p className="font-medium">{AGENT}</p>
					<p className="text-muted-foreground text-xs">Profile details</p>
				</div>
			</div>
			<p className="text-muted-foreground text-xs" data-testid="banner-state">
				{banner.preset.id}/{String(banner.color)}/{banner.direction}/wallpaper=
				{wallpaper?.id ?? "style"}
			</p>
		</section>
	);
}

function SettingsPane() {
	const [prompt, setPrompt] = useState("You are a careful assistant.");
	const [carded, setCarded] = useState("A carded textarea, for contrast.");
	return (
		<section className="flex flex-col gap-6" data-testid="settings-pane">
			<SettingsSection title="Rows">
				<SettingsGroup>
					<SettingsItem
						actions={<Switch checked data-testid="ordinary-switch" readOnly />}
						title="An ordinary row"
					/>
					{/* The row under test: a tall control, `bare`, so the group breaks
					    its card around it. */}
					<SettingsItem
						bare
						description="A bare row renders its own caption, because there is no card to hang one under."
						title="Custom instructions"
					>
						<Textarea
							className="min-h-24"
							data-testid="bare-textarea"
							onChange={(e) => setPrompt(e.target.value)}
							value={prompt}
						/>
					</SettingsItem>
					<SettingsItem
						actions={<Switch data-testid="trailing-switch" readOnly />}
						title="A row after it"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Cards">
				{/* The control group: the SAME textarea inside an ordinary card, which
				    is the doubled chrome the `bare` variant removes. */}
				<SettingsCard>
					<Textarea
						className="min-h-24"
						data-testid="carded-textarea"
						onChange={(e) => setCarded(e.target.value)}
						value={carded}
					/>
				</SettingsCard>
				<SettingsCard bare>
					<Textarea
						className="min-h-24"
						data-testid="bare-card-textarea"
						onChange={(e) => setPrompt(e.target.value)}
						value={prompt}
					/>
				</SettingsCard>
			</SettingsSection>

			{/* The judgement call, rendered rather than argued: a bare card holding a
			    textarea PLUS the affordances that belong to it (a status line, a
			    submit button) — the Memory tab's "Add to memory" shape. `bare` drops
			    the card's padding as well as its fill, so this is where you can see
			    whether the button and status still sit on the same rhythm as the
			    carded rows above them. */}
			<SettingsSection title="Bare card with its own affordances">
				<SettingsCard bare>
					<form
						className="flex flex-col gap-3"
						data-testid="bare-form"
						onSubmit={(e) => e.preventDefault()}
					>
						<Textarea
							onChange={(e) => setCarded(e.target.value)}
							placeholder="Text to remember…"
							rows={3}
							value={carded}
						/>
						<p className="text-muted-foreground text-sm">Indexed 3 chunks.</p>
						<div className="flex justify-end">
							<Button type="submit">Add to memory</Button>
						</div>
					</form>
				</SettingsCard>
			</SettingsSection>
		</section>
	);
}

function Story() {
	const theme = new URLSearchParams(window.location.search).get("theme");
	return (
		<div
			className={`${theme === "light" ? "" : "dark"} min-h-screen bg-background p-8 text-foreground`}
		>
			<div className="mx-auto grid max-w-4xl gap-10 md:grid-cols-2">
				<BannerPane />
				<SettingsPane />
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}

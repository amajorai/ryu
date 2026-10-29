import {
	AGENT_BANNER_BASE,
	AgentBannerDialog,
	type AgentBannerPreferenceStore,
	AgentBannerWash,
	AgentProfileBannerFade,
	resolveAgentBanner,
	useAgentBannerPrefs,
} from "@ryu/blocks/desktop/agent-banner-dialog.tsx";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	getMarketplaceBackdrops,
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { parsePublicProfileResponse } from "@ryuhq/protocol/public-profile";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProfileTab } from "../../src/components/settings/ProfileTab.tsx";
import { SpaceWallpaperCover } from "../../src/components/spaces/SpaceWallpaperCover.tsx";
import {
	type ApiTarget,
	getPreference,
	setPreference,
} from "../../src/lib/api/preferences.ts";
import { usePluginBackgrounds } from "../../src/lib/plugin-backgrounds.ts";
import { installWallpaper } from "../../src/lib/wallpaper-library.ts";
import "../../src/index.css";

const bannerBaseStyle: CSSProperties & { "--proof-banner-base": string } = {
	"--proof-banner-base": AGENT_BANNER_BASE,
};

const PROOF_TARGET: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "proof-node-token",
	userJwt: null,
};
const AGENT_ID = "banner-proof-agent";
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

localStorage.setItem("ryu_session_token", "proof-account-token");

const agentBannerStore: AgentBannerPreferenceStore = {
	get: (agentId) =>
		getPreference(
			PROOF_TARGET,
			`ryu.agent-banner.v1:${encodeURIComponent(agentId)}`
		),
	set: async (agentId, value) => {
		await setPreference(
			PROOF_TARGET,
			`ryu.agent-banner.v1:${encodeURIComponent(agentId)}`,
			value
		);
	},
};

function AgentBannerSurface() {
	const { error, loading, prefs, reset, update } = useAgentBannerPrefs(
		AGENT_ID,
		agentBannerStore
	);
	const wallpaper = resolveMarketplaceWallpaperSelection(prefs.wallpaper);
	const marketplaceWallpapers = usePluginBackgrounds();

	return (
		<section className="space-y-3" data-testid="agent-banner-surface">
			<div>
				<h2 className="font-medium text-lg">Agent profile</h2>
				<p className="text-muted-foreground text-sm">
					Shared with every device connected to this node.
				</p>
			</div>
			<div
				className="bg-(image:--proof-banner-base) relative min-h-48 overflow-hidden rounded-xl border"
				data-testid="agent-profile-banner"
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
					<AgentBannerWash banner={resolveAgentBanner(AGENT_ID, prefs)} />
				)}
				<AgentProfileBannerFade />
				<div className="absolute top-3 left-3 z-10">
					<AgentBannerDialog
						agent={AGENT_ID}
						loading={loading}
						marketplaceWallpapers={getMarketplaceBackdrops(
							marketplaceWallpapers
						)}
						onInstallWallpaper={(selected) => installWallpaper(selected.id)}
						onReset={reset}
						onUpdate={update}
						prefs={prefs}
						storageError={error}
					/>
				</div>
				<div className="absolute right-4 bottom-3 text-right text-white drop-shadow-sm">
					<p className="font-medium">Support Agent</p>
					<p className="text-white/80 text-xs">Agent details</p>
				</div>
			</div>
			<output className="sr-only" data-testid="agent-banner-selection">
				{wallpaper?.id ?? "style"}
			</output>
		</section>
	);
}

function PublicProfilePreview() {
	const [wallpaper, setWallpaper] = useState<RenderableBackdrop | undefined>();
	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/profile/public/proof-user");
			if (response.ok) {
				const profile = parsePublicProfileResponse(await response.json());
				setWallpaper(
					profile
						? resolveMarketplaceWallpaperSelection(
								profile.profile.bannerWallpaper
							)
						: undefined
				);
			}
		} catch {
			setWallpaper(undefined);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const interval = window.setInterval(() => {
			void refresh();
		}, 500);
		return () => window.clearInterval(interval);
	}, [refresh]);

	return (
		<section
			aria-label="Public user profile preview"
			className="space-y-3"
			data-testid="public-profile-surface"
		>
			<div>
				<h2 className="font-medium text-lg">Public user profile</h2>
				<p className="text-muted-foreground text-sm">
					Node-saved banner published for profile visitors.
				</p>
			</div>
			<div className="relative isolate h-44 overflow-hidden rounded-xl border bg-muted">
				{wallpaper ? (
					<Backdrop
						className="absolute inset-0"
						definition={wallpaper}
						live={false}
						params={wallpaper.initialParams}
					/>
				) : (
					<div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-muted to-background" />
				)}
				<div className="absolute inset-0 bg-gradient-to-t from-background/75 via-background/10 to-transparent" />
				<div className="absolute inset-x-4 bottom-3 font-medium text-foreground drop-shadow-sm">
					Ryu User
				</div>
			</div>
			<output className="sr-only" data-testid="public-profile-selection">
				{wallpaper?.id ?? "none"}
			</output>
		</section>
	);
}

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<main className="mx-auto min-h-screen max-w-7xl space-y-8 bg-background p-6 text-foreground">
				<header>
					<p className="text-muted-foreground text-sm">
						Wallpaper customization
					</p>
					<h1 className="font-semibold text-2xl">Banners across Ryu</h1>
				</header>
				<div className="grid gap-8 lg:grid-cols-2">
					<AgentBannerSurface />
					<SpaceWallpaperCover spaceId="proof-space" target={PROOF_TARGET} />
				</div>
				<div className="grid gap-8 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
					<section
						className="min-w-0 space-y-3"
						data-testid="account-profile-settings"
					>
						<ProfileTab />
					</section>
					<PublicProfilePreview />
				</div>
			</main>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element was not found.");
}

createRoot(root).render(<Story />);

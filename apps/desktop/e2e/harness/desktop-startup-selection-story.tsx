import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { savePluginBackgrounds } from "../../src/lib/plugin-backgrounds.ts";
import {
	DEFAULT_WALLPAPER_PREFERENCE,
	writeWallpaperPreference,
} from "../../src/lib/wallpaper.ts";
import "../../src/index.css";

const demoAccounts = [
	{
		email: "jiawei@example.com",
		image: null,
		name: "Jia Wei Ng",
		token: "proof-token-jiawei",
		userId: "proof-jiawei",
	},
	{
		email: "studio@example.com",
		image: null,
		name: "Studio account",
		token: "proof-token-studio",
		userId: "proof-studio",
	},
] as const;

// Seed only this proof page's in-memory browser origin. These are display-only
// fixtures; they never leave the local browser or reach an auth endpoint.
localStorage.setItem("ryu_accounts", JSON.stringify(demoAccounts));
localStorage.setItem("ryu_active_user_id", "proof-jiawei");
localStorage.setItem("ryu_startup_selection_mode", "always");
localStorage.removeItem("ryu_startup_default_account");
localStorage.removeItem("ryu_startup_default_node");
savePluginBackgrounds([
	{
		attribution: "PatternCraft",
		attributionUrl: "https://example.com/patterncraft/dawn",
		backdropId: "mesh-gradient",
		description: "Warm gradients for the start of the day.",
		id: "@example/wallpapers:dawn",
		label: "Dawn",
		params: { speed: 0.4 },
		plugin: "@example/wallpapers",
	},
	{
		attribution: "PatternCraft",
		attributionUrl: "https://example.com/patterncraft/aurora",
		backdropId: "aurora-flow",
		description: "Slow northern-lights colours over a dark sky.",
		id: "@example/wallpapers:aurora",
		label: "Aurora",
		params: { speed: 0.7 },
		plugin: "@example/wallpapers",
	},
	{
		attribution: "PatternCraft",
		attributionUrl: "https://patterncraft.fun/",
		backdropId: "patterncraft-css",
		description: "A soft violet grid with four glows.",
		id: "@example/wallpapers:patterncraft-grid",
		label: "PatternCraft Adapter Grid",
		params: { patternId: "grid-quad-purple-glow" },
		plugin: "@example/wallpapers",
	},
]);
writeWallpaperPreference({
	...DEFAULT_WALLPAPER_PREFERENCE,
	backdrop: { id: "@example/wallpapers:dawn", params: { speed: 0.4 } },
	mode: "backdrop",
});

async function bootstrap(): Promise<void> {
	try {
		const [{ DesktopStartupChooser }, { LOCAL_FALLBACK, useNodeStore }] =
			await Promise.all([
				import("../../src/components/startup/DesktopStartupChooser.tsx"),
				import("../../src/store/useNodeStore.ts"),
			]);

		const proofRemoteNode = {
			name: "Studio Mac",
			token: "proof-node-token",
			url: "https://studio.example.test",
		};

		useNodeStore.setState({
			cloudNodes: [],
			defaultNode: LOCAL_FALLBACK.name,
			localNodes: [LOCAL_FALLBACK, proofRemoteNode],
			nodes: [LOCAL_FALLBACK, proofRemoteNode],
			suggestedCloudNodes: [],
		});

		createRoot(document.getElementById("root")!).render(
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				enableSystem={false}
				storageKey="ryu-desktop-startup-selection-proof-theme"
			>
				<main className="h-screen bg-background text-foreground">
					<DesktopStartupChooser />
				</main>
				<Toaster position="bottom-right" theme="system" />
			</ThemeProvider>
		);
		document.body.dataset.harnessReady = "1";
	} catch (error) {
		document.body.dataset.harnessError =
			error instanceof Error ? error.message : String(error);
	}
}

void bootstrap();

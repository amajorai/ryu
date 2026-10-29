import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import MarketplaceDetailDialog from "../../src/components/marketplace/MarketplaceDetailDialog.tsx";
import type { MarketplaceKind } from "../../src/lib/api/marketplace.ts";
import "../../src/index.css";

document.documentElement.classList.add("dark");

const DETAIL = {
	banner: {
		colors: ["#101828", "#3658d4", "#7c3aed"],
		style: "gradient",
	},
	bannerUrl: null,
	capabilities: ["Network access", "Read files"],
	category: "Developer Tools",
	description:
		"Search your engineering workspace, summarize what changed, and turn the result into a useful next action.",
	developer: "Ryu Labs",
	examplePrompts: [
		"Find the deployment notes from this week",
		"Summarize the open incidents for my team",
		"Draft a release update from the latest changes",
	],
	firstParty: false,
	iconUrl: null,
	id: "com.example.research",
	// SAFETY: The authored app literal is an actual MarketplaceKind member; this fixture record is not derived from an unchecked runtime kind.
	kind: "app" as MarketplaceKind,
	name: "Research Desk",
	orgVerified: false,
	orgVerifiedTier: null,
	pricing: null,
	privacyPolicyUrl: "https://example.com/privacy",
	publisherTrust: "dotted" as const,
	publisherTrustSource: "none" as const,
	publisherVerification: null,
	ratingAverage: 4.7,
	ratingCount: 18,
	runnables: [
		{
			description: "Searches the connected engineering corpus.",
			enabled: true,
			id: "research-search",
			kind: "skill",
			name: "research-search",
		},
	],
	screenshots: [],
	setup: [
		{
			actionLabel: "Open setup",
			actionUrl: "https://example.com/setup",
			description: "Connect a workspace before the first run.",
			title: "Connect a workspace",
		},
	],
	tagline: "Answers from the work already around you.",
	termsOfServiceUrl: "https://example.com/terms",
	version: "1.2.0",
	website: "https://example.com",
};

function Story() {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const originalFetch = window.fetch;
		window.fetch = async (input, init) => {
			if (String(input).includes("/catalog/detail")) {
				return new Response(JSON.stringify(DETAIL), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				});
			}
			return originalFetch(input, init);
		};
		return () => {
			window.fetch = originalFetch;
		};
	}, []);

	return (
		<main className="flex min-h-svh items-center justify-center bg-muted/30 p-6 text-foreground">
			<button
				className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground"
				data-testid="open-marketplace-preview"
				onClick={() => setOpen(true)}
				type="button"
			>
				Open Marketplace preview
			</button>
			<MarketplaceDetailDialog
				id={DETAIL.id}
				initialName={DETAIL.name}
				kind={DETAIL.kind}
				onClose={() => setOpen(false)}
				open={open}
			/>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}

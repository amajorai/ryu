import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	AgentIdentityMode,
	AgentInstallDisclosure,
} from "@/src/lib/api/agents.ts";
import type {
	MarketplaceCard,
	MarketplaceDetail,
} from "@/src/lib/api/marketplace.ts";
import {
	CommunityAgentDetail,
	communityAgentNotice,
} from "./CommunityAgents.tsx";

const card: MarketplaceCard = {
	artifactKinds: [],
	author: "Publisher",
	bundleMemberCount: 0,
	category: null,
	communityStats: { downloads: 0, instances: 0, runs: 0 },
	description: "Researches things",
	downloadUrl: null,
	firstParty: false,
	githubSource: null,
	iconUrl: null,
	id: "researcher",
	installedVersion: null,
	installSource: null,
	kind: "agent",
	languagePack: null,
	latestVersion: null,
	likeCount: 0,
	likedByMe: false,
	membershipIncluded: false,
	name: "Researcher",
	orgVerified: false,
	orgVerifiedTier: null,
	packageChecksum: null,
	packageKind: null,
	packageSecurity: null,
	packageSource: null,
	pricing: null,
	publisherTrust: "dotted",
	publisherTrustSource: "none",
	publisherVerification: null,
	ratingAverage: 0,
	ratingCount: 0,
	requirements: {},
	scopes: [],
	targets: [],
	updateAvailable: false,
	updatePreview: null,
	verification: "verified",
	version: "1.0.0",
};

const requires: AgentInstallDisclosure = {
	composioActions: [],
	identityMode: null,
	identityProfileIds: [],
	memoryReadLevels: [],
	memoryWriteEnabled: false,
	policyId: null,
	remoteAvatarUrl: null,
	requiredPlugins: [],
	systemPromptTruncated: false,
	tools: [],
};

/** Render the detail with the listing's own detail already answered. */
function render(options: {
	listingMode: AgentIdentityMode | null;
	installedIdentityMode?: AgentIdentityMode | null;
	installed?: AgentInstallDisclosure | null;
	onOpenAccountAccess?: () => void;
}): string {
	const client = new QueryClient();
	const detail: Pick<
		MarketplaceDetail,
		"capabilities" | "description" | "examplePrompts" | "identityMode"
	> = {
		capabilities: [],
		description: null,
		examplePrompts: [],
		identityMode: options.listingMode,
	};
	client.setQueryData(["marketplace", "detail", "agent", card.id], detail);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<CommunityAgentDetail
				busy={false}
				card={card}
				installedIdentityMode={options.installedIdentityMode ?? null}
				onBuy={() => undefined}
				onInstall={() => undefined}
				onOpenAccountAccess={options.onOpenAccountAccess}
				requestedSpaceCount={0}
				requires={options.installed ?? null}
			/>
		</QueryClientProvider>
	);
}

describe("community agent identity", () => {
	test("the notice names what is never carried and where to limit access", () => {
		for (const mode of ["managed", "mixed", null] as const) {
			const notice = communityAgentNotice(mode);
			expect(notice).toContain(
				"It gets none of your credentials, Spaces or Composio actions."
			);
			expect(notice).toContain(
				"You can limit which of your accounts it may use under Account access after adding it."
			);
			expect(notice).not.toContain("never gains");
		}
		expect(communityAgentNotice("managed")).toContain(
			"Set to Acts as you, it can use your connected accounts"
		);
		expect(communityAgentNotice("mixed")).toContain("Set to Both,");
		expect(communityAgentNotice("individual")).toContain(
			"Set to Its own identity, it works with accounts of its own and never uses yours."
		);
	});

	test("the listing's mode is shown before install", () => {
		const html = render({ listingMode: "individual" });
		expect(html).toContain("Its own identity");
		expect(html).toContain("never uses yours");
		expect(html).not.toContain("Choose account access");
	});

	test("a listing that does not report a mode is labelled, not guessed", () => {
		const html = render({ listingMode: null });
		expect(html).toContain("Not stated");
		expect(html).not.toContain("Acts as you");
	});

	test("after install the agent's own mode wins and Account access is linked", () => {
		const html = render({
			listingMode: "managed",
			installedIdentityMode: "mixed",
			installed: { ...requires, identityMode: "managed" },
			onOpenAccountAccess: () => undefined,
		});
		expect(html).toContain("Set to Both,");
		expect(html).toContain("Choose account access");
		expect(html).toContain(
			"It can use your connected accounts until you limit which ones under Account access."
		);
	});

	test("no link without a host that can open the editor", () => {
		const html = render({
			listingMode: "managed",
			installed: { ...requires, identityMode: "managed" },
		});
		expect(html).toContain("Set this up yourself");
		expect(html).not.toContain("Choose account access");
	});
});

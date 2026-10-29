import { expect, test } from "bun:test";
import {
	type AgentPublishSource,
	buildAgentDescriptor,
	buildAgentPublishBody,
	deriveCapabilities,
	type PublishListing,
} from "./packaging.ts";

const source = {
	composioActions: [
		"GITHUB_CREATE_ISSUE",
		"composio.GITHUB_GET_ISSUE",
		"SLACK_POST_MESSAGE",
	],
	description: "A portable assistant",
	engine: "acp-exec:/private/bin/agent --token=local",
	expectedSpaces: [" Planning ", "Planning", ""],
	persona: {
		avatar_url: "data:image/png;base64,local",
		emoji: "🛠️",
		tone: "blue",
	},
	skills: ["planning"],
	systemPrompt: "  Plan and implement carefully.  ",
	tools: ["file_read", "web_search"],
	version: "1.2.3",
} satisfies AgentPublishSource;
const listing = {
	category: "productivity",
	description: "",
	displayName: "Portable Planner",
	examplePrompts: [" Plan a feature ", " "],
	iconUrl: "data:image/png;base64,local",
	screenshots: [
		"https://example.test/screenshot.png",
		"data:image/png;base64,local",
	],
	slug: "Portable Planner",
	tagline: " A useful planner ",
} satisfies PublishListing;

test("portable agent descriptors omit local commands and uploaded image contents", () => {
	const result = buildAgentDescriptor(source, listing.displayName);
	expect(result.descriptor.model).toBeNull();
	expect(result.descriptor.avatar?.avatar_url).toBeNull();
	expect(result.descriptor.avatar?.emoji).toBe("🛠️");
	expect(result.descriptor.spaces).toEqual([
		{ name: "Planning", purpose: null },
	]);
	expect(result.descriptor.connections).toEqual([
		{ provider: "github", purpose: null, required: true },
		{ provider: "slack", purpose: null, required: true },
	]);
	expect(result.notes).toEqual({
		blockedReason: null,
		droppedAvatarImage: true,
		droppedLocalCommand: true,
	});
	expect(JSON.stringify(result.descriptor)).not.toContain("/private/bin");
});

test("agent publish bodies retain provenance and listing normalization", () => {
	const body = buildAgentPublishBody(source, listing);
	expect(body.manifest).toEqual({
		id: "portable-planner",
		name: "Portable Planner",
		version: "1.2.3",
		kind: "agent",
	});
	expect(body.descriptor.system_prompt).toBe("Plan and implement carefully.");
	expect(body.iconUrl).toBeNull();
	expect(body.screenshots).toEqual(["https://example.test/screenshot.png"]);
	expect(body.examplePrompts).toEqual(["Plan a feature"]);
	expect(body.grants).toEqual([]);
});

test("unknown capability names remain text even when they name object prototype members", () => {
	expect(
		deriveCapabilities(
			["constructor", "toString", "__proto__", "web_search"],
			[]
		)
	).toEqual(["Constructor", "Tostring", "Proto", "Web search"]);
});

test("node-local account access never reaches the descriptor; the identity mode does", () => {
	// A caller that hands over a wider record-shaped object must still not ship
	// the publisher's account ids. The identity mode names whose accounts, never
	// which, so it is the one account setting that travels.
	const recordShaped: AgentPublishSource & {
		accountAccess: string[];
	} = {
		...source,
		accountAccess: ["composio:ca_publisher_secret", "agent:vault_acct_1"],
		identityMode: "individual",
	};
	const body = buildAgentPublishBody(recordShaped, listing);
	const serialized = JSON.stringify(body);
	expect(serialized).not.toContain("ca_publisher_secret");
	expect(serialized).not.toContain("vault_acct_1");
	expect(serialized).not.toContain("account_access");
	expect(body.descriptor.identity_mode).toBe("individual");
});

test("an agent without an identity mode publishes as Core's default", () => {
	expect(buildAgentDescriptor(source, "Planner").descriptor.identity_mode).toBe(
		"managed"
	);
});

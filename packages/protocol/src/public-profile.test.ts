import { describe, expect, it } from "bun:test";
import {
	DEFAULT_PUBLIC_PROFILE_SECTIONS,
	defaultPublicProfileContent,
	parsePublicProfileContent,
	parsePublicProfileResponse,
} from "./public-profile.ts";

describe("public profile content", () => {
	it("returns no projection for missing or scalar boundary input", () => {
		for (const input of [undefined, null, false, 0, "profile"]) {
			expect(parsePublicProfileContent(input)).toBeUndefined();
			expect(parsePublicProfileResponse(input)).toBeUndefined();
		}
	});

	it("preserves inherited legacy fields while rejecting unknown own content fields", () => {
		const input = Object.create({ bio: " inherited ", hidden: "private" });
		Object.defineProperty(input, "links", { value: [] });
		expect(parsePublicProfileContent(input)).toEqual({
			...defaultPublicProfileContent(),
			bio: "inherited",
		});
		Object.defineProperty(input, "hidden", {
			value: "private",
			enumerable: true,
		});
		expect(parsePublicProfileContent(input)).toBeUndefined();
	});

	it("reads current section defaults and returns independent result objects", () => {
		const original = DEFAULT_PUBLIC_PROFILE_SECTIONS.agents;
		try {
			DEFAULT_PUBLIC_PROFILE_SECTIONS.agents = false;
			const first = parsePublicProfileContent({ sections: {} });
			const second = parsePublicProfileContent({});
			expect(first?.sections.agents).toBe(false);
			expect(second?.sections.agents).toBe(false);
			expect(first?.sections).not.toBe(second?.sections);
		} finally {
			DEFAULT_PUBLIC_PROFILE_SECTIONS.agents = original;
		}
	});

	it("fills safe defaults for older profile records", () => {
		expect(parsePublicProfileContent({})).toEqual(
			defaultPublicProfileContent()
		);
	});

	it("accepts bounded HTTPS links and section choices", () => {
		expect(
			parsePublicProfileContent({
				bio: "  Designer and builder  ",
				links: [
					{
						href: "https://example.com/about",
						id: "website",
						kind: "website",
						label: "Website",
					},
				],
				sections: { plugins: false },
				showcase: [
					{
						description: "A small project",
						href: "https://example.com/project",
						id: "project-one",
						imageUrl: "https://cdn.example.com/project.webp",
						title: "Project one",
					},
				],
			})
		).toEqual({
			bio: "Designer and builder",
			links: [
				{
					href: "https://example.com/about",
					id: "website",
					kind: "website",
					label: "Website",
				},
			],
			sections: { ...defaultPublicProfileContent().sections, plugins: false },
			showcase: [
				{
					description: "A small project",
					href: "https://example.com/project",
					id: "project-one",
					imageUrl: "https://cdn.example.com/project.webp",
					title: "Project one",
				},
			],
		});
	});

	it("rejects scriptable, credential-bearing, and private-network URLs", () => {
		for (const href of [
			"javascript:alert(1)",
			"http://example.com",
			"https://user:pass@example.com",
			"https://127.0.0.1/private",
			"https://printer.local",
		]) {
			expect(
				parsePublicProfileContent({
					links: [
						{
							href,
							id: "unsafe",
							kind: "website",
							label: "Unsafe",
						},
					],
				})
			).toBeUndefined();
		}
	});

	it("rejects duplicate ids and over-limit collections", () => {
		const duplicateLinks = [
			{
				href: "https://one.example.com",
				id: "same",
				kind: "website",
				label: "First",
			},
			{
				href: "https://two.example.com",
				id: "same",
				kind: "social",
				label: "Second",
			},
		];
		expect(
			parsePublicProfileContent({ links: duplicateLinks })
		).toBeUndefined();
		expect(
			parsePublicProfileContent({
				links: Array.from({ length: 9 }, (_, index) => ({
					href: `https://site-${index}.example.com`,
					id: `site-${index}`,
					kind: "website",
					label: `Site ${index}`,
				})),
			})
		).toBeUndefined();
	});

	it("rejects unknown fields and control characters", () => {
		expect(
			parsePublicProfileContent({ bio: "hi", privateKey: "value" })
		).toBeUndefined();
		expect(
			parsePublicProfileContent({ bio: "hello\u0000world" })
		).toBeUndefined();
	});

	it("parses a public projection without carrying private account fields", () => {
		const parsed = parsePublicProfileResponse({
			profile: {
				bannerWallpaper: null,
				displayUsername: "ryu_user",
				image: null,
				joinedAt: "2025-01-01T00:00:00.000Z",
				level: 2,
				name: "Ryu User",
				pointsBalance: 800,
				publicProfile: defaultPublicProfileContent(),
				streak: { current: 3, longest: 7 },
				totals: {
					agentSeconds: 3600,
					costMicroUsd: 900,
					inputTokens: 1200,
					outputTokens: 300,
					requestCount: 25,
				},
				username: "ryu_user",
				userId: "private-id",
				verificationDetails: { methods: [], verifiedSince: null },
			},
			stats: { insights: { topModels: [{ count: 3, id: "model-a" }] } },
			usage: null,
		});

		expect(parsed?.profile.totals).toEqual({
			agentSeconds: 3600,
			inputTokens: 1200,
			outputTokens: 300,
			requestCount: 25,
		});
		expect(parsed?.profile).not.toHaveProperty("pointsBalance");
		expect(parsed?.profile).not.toHaveProperty("userId");
		expect(parsed?.profile.totals).not.toHaveProperty("costMicroUsd");
	});
});

import { z } from "zod";
import {
	type MarketplaceWallpaperSelection,
	marketplaceWallpaperSelectionSchema,
} from "./marketplace-wallpaper.ts";
import { wireObject } from "./wire-object.ts";

export type PublicProfileSection =
	| "agents"
	| "activity"
	| "usage"
	| "models"
	| "plugins"
	| "showcase";

export interface PublicProfileSections {
	activity: boolean;
	agents: boolean;
	models: boolean;
	plugins: boolean;
	showcase: boolean;
	usage: boolean;
}

export interface PublicProfileLink {
	href: string;
	id: string;
	kind: "social" | "website";
	label: string;
}

export interface PublicProfileShowcaseItem {
	description: string;
	href: string;
	id: string;
	imageUrl: string | null;
	title: string;
}

export interface PublicProfileContent {
	bio: string;
	links: PublicProfileLink[];
	sections: PublicProfileSections;
	showcase: PublicProfileShowcaseItem[];
}

export interface PublicProfileTotals {
	agentSeconds: number;
	inputTokens: number;
	outputTokens: number;
	requestCount: number;
}

export interface PublicProfileStats {
	insights: {
		activeDays?: number;
		averageTokensPerActiveDay?: number;
		favoriteModel?: string | null;
		topModels?: Array<{ count: number; id: string }>;
		topPlugins?: Array<{ count: number; id: string }>;
	};
}

export interface PublicProfileUsageDay {
	count: number;
	day: string;
	tokens: number;
}

export interface PublicProfileResponse {
	profile: {
		bannerWallpaper: MarketplaceWallpaperSelection | null;
		displayUsername: string;
		image: string | null;
		joinedAt: string | null;
		level: number;
		name: string;
		publicProfile: PublicProfileContent;
		streak?: { current: number; longest: number };
		totals?: PublicProfileTotals;
		username: string;
		verificationDetails: {
			methods: Array<{ kind: "domain" | "email"; label: string }>;
			verifiedSince: string | null;
		};
	};
	stats: PublicProfileStats | null;
	usage: PublicProfileUsageDay[] | null;
}

export const DEFAULT_PUBLIC_PROFILE_SECTIONS: PublicProfileSections = {
	agents: true,
	activity: true,
	usage: true,
	models: true,
	plugins: true,
	showcase: true,
};

const PUBLIC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CONTENT_BYTES = 32_768;

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
}

function isSafePublicUrl(value: string): boolean {
	if (
		value.length > 2048 ||
		value.trim() !== value ||
		hasControlCharacter(value)
	) {
		return false;
	}
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		const privateIpv4 =
			host.startsWith("127.") ||
			host.startsWith("10.") ||
			host.startsWith("192.168.") ||
			host.startsWith("169.254.") ||
			/^172\.(1[6-9]|2\d|3[01])\./u.test(host);
		return (
			url.protocol === "https:" &&
			url.username.length === 0 &&
			url.password.length === 0 &&
			!privateIpv4 &&
			host !== "localhost" &&
			!host.endsWith(".localhost") &&
			!host.endsWith(".local") &&
			host.includes(".")
		);
	} catch {
		return false;
	}
}

const nonNegative = z.number().finite().nonnegative();
const publicUrl = z.string().refine(isSafePublicUrl);
const publicId = z.string().regex(PUBLIC_ID_RE);
const label = z
	.string()
	.max(40)
	.refine((value) => value.trim().length > 0 && !hasControlCharacter(value))
	.transform((value) => value.trim());
const sections = wireObject(
	{
		agents: z.boolean().default(() => DEFAULT_PUBLIC_PROFILE_SECTIONS.agents),
		activity: z
			.boolean()
			.default(() => DEFAULT_PUBLIC_PROFILE_SECTIONS.activity),
		usage: z.boolean().default(() => DEFAULT_PUBLIC_PROFILE_SECTIONS.usage),
		models: z.boolean().default(() => DEFAULT_PUBLIC_PROFILE_SECTIONS.models),
		plugins: z.boolean().default(() => DEFAULT_PUBLIC_PROFILE_SECTIONS.plugins),
		showcase: z
			.boolean()
			.default(() => DEFAULT_PUBLIC_PROFILE_SECTIONS.showcase),
	},
	true
).default(() => ({ ...DEFAULT_PUBLIC_PROFILE_SECTIONS }));
const links = z
	.array(
		wireObject(
			{
				href: publicUrl,
				id: publicId,
				kind: z.enum(["social", "website"]),
				label,
			},
			true
		)
	)
	.max(8)
	.refine(
		(items) => new Set(items.map((item) => item.id)).size === items.length
	)
	.default(() => []);
const showcase = z
	.array(
		wireObject(
			{
				description: z
					.string()
					.max(180)
					.refine((value) => !hasControlCharacter(value))
					.transform((value) => value.trim()),
				href: publicUrl,
				id: publicId,
				imageUrl: publicUrl.nullish().transform((value) => value ?? null),
				title: z
					.string()
					.max(60)
					.refine(
						(value) => value.trim().length > 0 && !hasControlCharacter(value)
					)
					.transform((value) => value.trim()),
			},
			true
		)
	)
	.max(12)
	.refine(
		(items) => new Set(items.map((item) => item.id)).size === items.length
	)
	.default(() => []);
const content = wireObject(
	{
		bio: z
			.string()
			.max(280)
			.refine((value) => !hasControlCharacter(value))
			.nullish()
			.transform((value) => value?.trim() ?? ""),
		links,
		sections,
		showcase,
	},
	true
).refine((value) => JSON.stringify(value).length <= MAX_CONTENT_BYTES);

export function defaultPublicProfileContent(): PublicProfileContent {
	return {
		bio: "",
		links: [],
		sections: { ...DEFAULT_PUBLIC_PROFILE_SECTIONS },
		showcase: [],
	};
}

/** Parse profile content at the API and persistence boundaries. */
export const parsePublicProfileContent = content
	.or(z.undefined())
	.catch(undefined).parse;

const ranked = z
	.array(wireObject({ count: nonNegative, id: z.string().min(1).max(128) }))
	.max(8);
const insights = wireObject({
	activeDays: nonNegative.optional(),
	averageTokensPerActiveDay: nonNegative.optional(),
	favoriteModel: z.string().nullable().optional(),
	topModels: ranked.optional(),
	topPlugins: ranked.optional(),
}).transform((value): PublicProfileStats["insights"] => {
	const result: PublicProfileStats["insights"] = {};
	if (value.activeDays !== undefined) {
		result.activeDays = value.activeDays;
	}
	if (value.averageTokensPerActiveDay !== undefined) {
		result.averageTokensPerActiveDay = value.averageTokensPerActiveDay;
	}
	if (value.favoriteModel !== undefined) {
		result.favoriteModel = value.favoriteModel;
	}
	if (value.topModels !== undefined) {
		result.topModels = value.topModels;
	}
	if (value.topPlugins !== undefined) {
		result.topPlugins = value.topPlugins;
	}
	return result;
});
const stats = wireObject({ insights }).nullable();
const totals = wireObject({
	agentSeconds: nonNegative,
	inputTokens: nonNegative,
	outputTokens: nonNegative,
	requestCount: nonNegative,
});
const usage = z
	.array(
		wireObject({
			count: nonNegative,
			day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
			tokens: nonNegative,
		})
	)
	.max(400)
	.nullable();
const profile = wireObject({
	bannerWallpaper: marketplaceWallpaperSelectionSchema.nullable(),
	displayUsername: z.string().max(64),
	image: z.string().nullable(),
	joinedAt: z.string().nullable(),
	level: nonNegative,
	name: z.string().max(200),
	publicProfile: content,
	username: z.string().max(64),
	verificationDetails: wireObject({
		methods: z.array(
			wireObject({
				kind: z.enum(["domain", "email"]),
				label: z.string().max(80),
			})
		),
		verifiedSince: z.string().nullable(),
	}),
	totals: totals.optional(),
	streak: wireObject({ current: nonNegative, longest: nonNegative }).optional(),
}).transform((value): PublicProfileResponse["profile"] => {
	const result: PublicProfileResponse["profile"] = {
		bannerWallpaper: value.bannerWallpaper,
		displayUsername: value.displayUsername,
		image: value.image,
		joinedAt: value.joinedAt,
		level: value.level,
		name: value.name,
		publicProfile: value.publicProfile,
		username: value.username,
		verificationDetails: value.verificationDetails,
	};
	if (value.totals !== undefined) {
		result.totals = value.totals;
	}
	if (value.streak !== undefined) {
		result.streak = value.streak;
	}
	return result;
});

/** Parse and project the complete public wire response at the API boundary. */
export const parsePublicProfileResponse = wireObject({ profile, stats, usage })
	.or(z.undefined())
	.catch(undefined).parse;

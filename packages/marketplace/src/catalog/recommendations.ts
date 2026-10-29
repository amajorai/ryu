import { z } from "zod";

export type RecommendationKind =
	| "app"
	| "plugin"
	| "skill"
	| "mcp"
	| "agent"
	| "model";

export interface RecommendationItem {
	description: string | null;
	iconUrl: string | null;
	id: string;
	installed: boolean;
	kind: RecommendationKind;
	name: string;
	reason: string;
}

export interface RecommendationWire {
	cadence?: string;
	enabled?: boolean;
	hidden?: boolean;
	items?: unknown;
}

export interface NormalizedRecommendations {
	cadence: "daily" | "weekly" | "monthly";
	enabled: boolean;
	hidden: boolean;
	items: RecommendationItem[];
}

const recommendationKindSchema = z.enum([
	"agent",
	"app",
	"mcp",
	"model",
	"plugin",
	"skill",
]);
const recommendationTextSchema = z
	.string()
	.trim()
	.min(1)
	.nullable()
	.catch(null);
const recommendationItemSchema = z
	.object({
		id: z.string().trim().min(1),
		name: z.string().trim().min(1),
		kind: z.string().trim().pipe(recommendationKindSchema),
		description: recommendationTextSchema,
		icon_url: z.unknown().optional(),
		iconUrl: z.unknown().optional(),
		installed: z.boolean().catch(false),
		reason: recommendationTextSchema,
	})
	.transform(
		(item): RecommendationItem => ({
			description: item.description,
			iconUrl: recommendationTextSchema.parse(item.icon_url ?? item.iconUrl),
			id: item.id,
			installed: item.installed,
			kind: item.kind,
			name: item.name,
			reason: item.reason ?? "A match for your current catalog setup.",
		})
	);
const recommendationsSchema = z
	.object({
		cadence: z.enum(["daily", "weekly", "monthly"]).catch("weekly"),
		enabled: z.boolean().catch(true),
		hidden: z.boolean().catch(false),
		items: z
			.custom<unknown[]>(Array.isArray)
			.transform((items) =>
				items.flatMap((entry) => {
					const parsed = recommendationItemSchema.safeParse(entry);
					return parsed.success ? [parsed.data] : [];
				})
			)
			.catch(() => []),
	})
	.catch(() => ({
		cadence: "weekly" as const,
		enabled: true,
		hidden: false,
		items: [],
	}));

export function normalizeRecommendations(
	value: RecommendationWire | null | undefined
): NormalizedRecommendations {
	return recommendationsSchema.parse(value);
}

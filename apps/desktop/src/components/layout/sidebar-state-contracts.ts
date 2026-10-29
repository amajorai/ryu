import { z } from "zod";
import { isSectionKey, type SectionKey } from "./sidebar-sections.ts";

export const sidebarSortSchema = z.enum([
	"default",
	"updated",
	"created",
	"name-asc",
	"name-desc",
	// Chat sections only; other sections keep their source order for these.
	"status",
	"messages",
]);
export type SidebarSort = z.output<typeof sidebarSortSchema>;
type SidebarPageSizes = Partial<Record<SectionKey, number>>;
type SidebarSorts = Partial<Record<SectionKey, SidebarSort>>;
const pageSizesInputSchema = z.record(
	z.string(),
	z.number().optional().catch(undefined)
);
const sortsInputSchema = z.record(
	z.string(),
	sidebarSortSchema.optional().catch(undefined)
);

/** Legacy rows are independent: one malformed entry must not reset another section. */
export function parseSidebarPageSizes(
	input: Parameters<typeof pageSizesInputSchema.parse>[0]
) {
	const result: SidebarPageSizes = {};
	const parsed = pageSizesInputSchema.safeParse(input);
	if (!parsed.success) {
		return result;
	}
	for (const [key, value] of Object.entries(parsed.data)) {
		if (isSectionKey(key) && value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}
export function parseSidebarSorts(
	input: Parameters<typeof sortsInputSchema.parse>[0]
) {
	const result: SidebarSorts = {};
	const parsed = sortsInputSchema.safeParse(input);
	if (!parsed.success) {
		return result;
	}
	for (const [key, value] of Object.entries(parsed.data)) {
		if (isSectionKey(key) && value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

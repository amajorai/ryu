import { z } from "zod";
import type {
	GradientStop,
	SurfaceBackground,
} from "../src/hooks/useBackgroundCustomization.ts";
import {
	type PluginDocument,
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import type { ThemeVariant } from "../src/lib/themes/presets.ts";

const storedThemeFieldsSchema = z.object({
	id: z.string(),
	label: z.string(),
	mode: z.enum(["light", "dark"]),
	tokens: z.record(z.string(), z.string()),
}) satisfies z.ZodType<Pick<ThemeVariant, "id" | "label" | "mode" | "tokens">>;
export const storedAppearanceThemesSchema = z.custom<
	Array<z.output<typeof storedThemeFieldsSchema> & PluginDocument>
>(
	(value) =>
		pluginValueSchema.safeParse(value).success &&
		z.array(storedThemeFieldsSchema).safeParse(value).success
);
const gradientStopSchema = z.object({
	color: z.string(),
	position: z.number(),
}) satisfies z.ZodType<GradientStop>;
const backgroundFieldsSchema = z.object({
	gradientAngle: z.number().optional(),
	gradientEnabled: z.boolean().optional(),
	gradientStops: z.array(gradientStopSchema).optional(),
	imageEnabled: z.boolean().optional(),
}) satisfies z.ZodType<
	Partial<
		Pick<
			SurfaceBackground,
			"gradientAngle" | "gradientEnabled" | "gradientStops" | "imageEnabled"
		>
	>
>;
export const appearanceBackgroundProofSchema = z.custom<
	z.output<typeof backgroundFieldsSchema> & PluginDocument
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		backgroundFieldsSchema.safeParse(value).success
);
const languageRequestFieldsSchema = z.object({
	method: z.string(),
	path: z.string(),
});
export const appearanceLanguageRequestsSchema = z.custom<
	Array<z.output<typeof languageRequestFieldsSchema> & PluginDocument>
>(
	(value) =>
		pluginValueSchema.safeParse(value).success &&
		z.array(languageRequestFieldsSchema).safeParse(value).success
);

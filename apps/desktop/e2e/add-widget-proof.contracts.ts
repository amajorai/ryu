import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
import {
	type WidgetInput,
	widgetInputSchema,
} from "../src/components/dashboard/widgets/schema.ts";

/** The actual complete widget input owner validates all fields/source variants.
 * Its per-kind config/data remain opaque native JSON, owned by renderer schemas;
 * raw roots, future fields and nested references are retained for assertions. */
export const addWidgetProofInputSchema = z.custom<WidgetInput>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		widgetInputSchema.safeParse(value).success
);
const proofStateFields = z.object({
	createCount: z.number(),
	created: addWidgetProofInputSchema.nullable(),
	open: z.boolean(),
});
export const addWidgetProofStateSchema = z.custom<
	z.output<typeof proofStateFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		proofStateFields.safeParse(value).success
);
export type AddWidgetProofState = z.output<typeof addWidgetProofStateSchema>;

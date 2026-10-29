import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import type { RequestOptions } from "@ryuhq/core-client/client";
import { z } from "zod";
import { type LocalizedText, localize } from "../localizedText.ts";
import { type CliContext, type Command, UsageError } from "../types.ts";

// Full native session revoke publisher: success/message, with legacy omitted message
// and existing explicit failure receipts retained. The HTTP tree is kept intact.
const commandSessionReceiptFields = z.object({
	success: z.boolean().optional(),
	message: z.string().optional(),
	error: z.string().optional(),
});
export const commandSessionReceiptSchema = z.custom<
	z.output<typeof commandSessionReceiptFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		commandSessionReceiptFields.safeParse(value).success
);
export const commandJsonSchema = z.json().optional();
export type CommandJsonValue = z.infer<typeof commandJsonSchema>;
const commandRecordSchema = z.record(z.string(), z.json());
export type CommandJsonRecord = z.infer<typeof commandRecordSchema>;
const commandStringSchema = z.string();
const commandFiniteNumberSchema = z.number();

export function isCommandString(value: CommandJsonValue): value is string {
	return commandStringSchema.safeParse(value).success;
}
export function isCommandNumber(value: CommandJsonValue): value is number {
	return commandFiniteNumberSchema.safeParse(value).success;
}
export const DESCRIPTION_WIDTH = 50;
/** Shown in `node ls --json` instead of a saved node token. */
export const REDACTED_NODE_TOKEN = "••••••";

export async function callCore(
	ctx: CliContext,
	path: string,
	options: Pick<RequestOptions, "method" | "body"> = {}
): Promise<CommandJsonValue> {
	if (!ctx.api.call) {
		throw new Error("This command requires the live Core client.");
	}
	return commandJsonSchema.parse(
		await ctx.api.call(ctx.target, path, {
			method: options.method ?? "POST",
			body: options.body,
		})
	);
}

export function rawCommand(
	name: string,
	usage: string,
	summary: string,
	path: string,
	method: string,
	argsToBody = false
): Command {
	return {
		name,
		summary,
		usage,
		run: async (ctx) => {
			const body = argsToBody ? { args: ctx.args } : undefined;
			const result = await callCore(ctx, path, { method, body });
			ctx.io.out(
				`${ctx.flags.json ? JSON.stringify(result, null, 2) : JSON.stringify(result)}\n`
			);
			return 0;
		},
	};
}

export function asRecord(
	value: Parameters<typeof commandRecordSchema.safeParse>[0]
): CommandJsonRecord | null {
	const parsed = commandRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function outputCommandResult(
	ctx: CliContext,
	value: Parameters<typeof JSON.stringify>[0],
	human: string
): void {
	ctx.io.out(
		ctx.flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`
	);
}

/** Read the first positional arg or throw a usage error naming the correct form. */
export function requireArg(
	ctx: CliContext,
	name: string | LocalizedText,
	usage: string
): string {
	const value = ctx.args[0];
	if (!value) {
		throw new UsageError(
			localize("Missing {name}. Usage: {usage}", { name, usage })
		);
	}
	return value;
}

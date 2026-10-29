import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { z } from "zod";
import { type DiffLine, toolDiffLines } from "@/components/ui/diff.tsx";
import { asRecord } from "./chatTranscript.ts";

export interface ChatPermissionOption {
	kind: string;
	name: string;
	optionId: string;
}

const permissionToolCallSchema = z.json().optional();
type PermissionToolCall = z.infer<typeof permissionToolCallSchema>;

export interface ChatPermission {
	options: ChatPermissionOption[];
	requestId: string;
	toolCall: PermissionToolCall;
}

const permissionOptionSchema = z.object({
	optionId: z.string().min(1),
	name: z.string(),
	kind: z.string(),
});
const chatPermissionSchema = z.object({
	requestId: z.string().min(1),
	options: z.array(permissionOptionSchema.nullable().catch(null)),
	toolCall: permissionToolCallSchema.catch(undefined),
});
const permissionToolTitleSchema = z.object({
	title: z.json().optional(),
	fields: z
		.object({ title: z.json().optional() })
		.nullable()
		.optional()
		.catch(undefined),
});
const permissionToolCallIdSchema = z.object({
	toolCallId: z.string().min(1),
});
const permissionResolutionSchema = z.object({ resolved: z.boolean() });

export function parseChatPermission(
	value: Parameters<typeof chatPermissionSchema.safeParse>[0]
): ChatPermission | null {
	const parsed = chatPermissionSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const options = parsed.data.options.flatMap((option) =>
		option ? [option] : []
	);
	return options.length > 0
		? {
				options,
				requestId: parsed.data.requestId,
				toolCall: parsed.data.toolCall,
			}
		: null;
}

export function permissionToolTitle(
	toolCall: Parameters<typeof permissionToolTitleSchema.safeParse>[0]
): string {
	const parsed = permissionToolTitleSchema.safeParse(toolCall);
	if (!parsed.success) {
		return "run a tool";
	}
	const title = z
		.string()
		.min(1)
		.safeParse(parsed.data.title ?? parsed.data.fields?.title);
	return title.success ? title.data : "run a tool";
}

/** The ACP `toolCall.toolCallId` a permission request is about, if any. */
export function permissionToolCallId(
	toolCall: Parameters<typeof permissionToolCallIdSchema.safeParse>[0]
): string | undefined {
	const parsed = permissionToolCallIdSchema.safeParse(toolCall);
	return parsed.success ? parsed.data.toolCallId : undefined;
}

// ACP agents disagree on where tool-call metadata lives: some send it at the
// top level, others nest it under `fields`. Each field is parsed on its own so
// one malformed value never hides the rest.
const permissionToolFieldsSchema = z.object({
	toolCallId: z.string().min(1).optional().catch(undefined),
	kind: z.string().min(1).optional().catch(undefined),
	title: z.string().min(1).optional().catch(undefined),
	rawInput: z.json().optional().catch(undefined),
	content: z.array(z.json()).optional().catch(undefined),
	locations: z.array(z.json()).optional().catch(undefined),
});
const permissionToolDetailSchema = permissionToolFieldsSchema.extend({
	fields: permissionToolFieldsSchema.nullable().optional().catch(undefined),
});
const nonEmptyString = z.string().min(1).optional().catch(undefined);
const permissionRawInputSchema = z.object({
	command: z
		.union([z.string().min(1), z.array(z.string()).min(1)])
		.optional()
		.catch(undefined),
	cwd: nonEmptyString,
	file_path: nonEmptyString,
	filePath: nonEmptyString,
	path: nonEmptyString,
});
const permissionLocationSchema = z.object({ path: z.string().min(1) });
const permissionDiffContentSchema = z.object({
	type: z.literal("diff"),
	path: z.string().min(1),
	oldText: z.string().nullable().optional(),
	newText: z.string(),
});

/** What a permission prompt shows about the tool call it is asking for. */
export interface PermissionToolDetail {
	command?: string;
	cwd?: string;
	/** Unified diff lines when the tool input carries an edit, else null. */
	diff: DiffLine[] | null;
	/** ACP tool kind: `execute`, `edit`, `read`, `fetch`, ... */
	kind?: string;
	path?: string;
	title: string;
	toolCallId?: string;
}

const splitDiffText = (text: string, prefix: "+ " | "- ") =>
	text.split("\n").map((line) => `${prefix}${line}`);

/** Unified diff lines from ACP `content[]` entries of `type: "diff"`. */
function contentDiffLines(
	content: z.infer<typeof permissionToolFieldsSchema>["content"]
): DiffLine[] | null {
	const lines: DiffLine[] = [];
	for (const entry of content ?? []) {
		const diff = permissionDiffContentSchema.safeParse(entry);
		if (!diff.success) {
			continue;
		}
		const { path, oldText, newText } = diff.data;
		lines.push(
			{ kind: "header", text: `--- ${path}` },
			{ kind: "header", text: `+++ ${path}` }
		);
		if (oldText) {
			for (const text of splitDiffText(oldText, "- ")) {
				lines.push({ kind: "removed", text });
			}
		}
		for (const text of splitDiffText(newText, "+ ")) {
			lines.push({ kind: "added", text });
		}
	}
	return lines.length > 0 ? lines : null;
}

/**
 * Pull the command, working directory, path and diff out of an ACP permission
 * `toolCall` so the prompt can show what is being approved, not just a title.
 */
export function permissionToolDetail(
	toolCall: Parameters<typeof permissionToolDetailSchema.safeParse>[0]
): PermissionToolDetail {
	const title = permissionToolTitle(toolCall);
	const parsed = permissionToolDetailSchema.safeParse(toolCall);
	if (!parsed.success) {
		return { title, diff: null };
	}
	const top = parsed.data;
	const nested = top.fields ?? undefined;
	const kind = top.kind ?? nested?.kind;
	const toolCallId = top.toolCallId ?? nested?.toolCallId;
	const rawInput = top.rawInput ?? nested?.rawInput;
	const content = top.content ?? nested?.content;
	const locations = top.locations ?? nested?.locations;
	const input = permissionRawInputSchema.safeParse(rawInput);
	const fields = input.success ? input.data : undefined;
	const command = Array.isArray(fields?.command)
		? fields.command.join(" ")
		: fields?.command;
	const location = permissionLocationSchema.safeParse(locations?.[0]);
	const rawArgs = asRecord(rawInput);
	const diffName =
		kind === "edit" ? "Edit" : (top.title ?? nested?.title ?? "");
	const diff =
		contentDiffLines(content) ??
		(rawArgs ? toolDiffLines(diffName, { rawInput: rawArgs }) : null);
	const path =
		fields?.file_path ??
		fields?.filePath ??
		fields?.path ??
		(location.success ? location.data.path : undefined);
	return {
		title,
		diff,
		...(kind ? { kind } : {}),
		...(toolCallId ? { toolCallId } : {}),
		...(command ? { command } : {}),
		...(fields?.cwd ? { cwd: fields.cwd } : {}),
		...(path ? { path } : {}),
	};
}

/** Whether choosing this option refuses the tool call (`reject_once`, ...). */
export function isRejectPermissionOption(
	option: ChatPermissionOption
): boolean {
	return option.kind.startsWith("reject");
}

export async function respondToChatPermission(
	target: ApiTarget,
	requestId: string,
	optionId: string | null
): Promise<boolean> {
	const response = permissionResolutionSchema.parse(
		await request(
			target,
			"/api/chat/permission",
			{
				method: "POST",
				body: { request_id: requestId, option_id: optionId },
			},
			appResponseValueSchema
		)
	);
	return response.resolved;
}

/* @jsxImportSource @opentui/react */
import { z } from "zod";
import { useTheme } from "@/components/ui/theme-provider";
import {
	asRecord,
	type ChatToolArguments,
	type ChatToolResult,
} from "@/src/core/chatTranscript.ts";

export type DiffLineKind = "header" | "added" | "removed" | "context";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

const diffTextSchema = z.string();
const asString = (value: ChatToolResult): string | undefined => {
	const parsed = diffTextSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
};

/** Build a compact unified diff from the common ACP Edit/ApplyPatch shapes. */
export const toolDiffLines = (
	name: string,
	args: ChatToolArguments | undefined,
): DiffLine[] | null => {
	if (!args || !["Edit", "ApplyPatch", "edit", "apply_patch"].includes(name)) {
		return null;
	}
	const nested = asRecord(args.rawInput) ?? args;
	const patch = asString(nested.patch) ?? asString(nested.diff);
	if (patch) {
		return patch.split("\n").map((text) => {
			const isHeader =
				text.startsWith("@@") ||
				text.startsWith("diff ") ||
				text.startsWith("index ") ||
				text.startsWith("--- ") ||
				text.startsWith("+++ ");
			return {
				kind: isHeader
					? "header"
					: text.startsWith("+")
						? "added"
						: text.startsWith("-")
							? "removed"
							: "context",
				text,
			};
		});
	}
	const oldText = asString(nested.old_string) ?? asString(nested.oldString);
	const newText = asString(nested.new_string) ?? asString(nested.newString);
	if (oldText === undefined || newText === undefined) {
		return null;
	}
	const file =
		asString(nested.file_path) ?? asString(nested.filePath) ?? "file";
	return [
		{ kind: "header", text: `--- ${file}` },
		{ kind: "header", text: `+++ ${file}` },
		...oldText
			.split("\n")
			.map((text) => ({ kind: "removed" as const, text: `- ${text}` })),
		...newText
			.split("\n")
			.map((text) => ({ kind: "added" as const, text: `+ ${text}` })),
	];
};

export function Diff({ lines }: { lines: DiffLine[] }) {
	const theme = useTheme();
	return (
		<box
			borderColor={theme.colors.border}
			borderStyle="single"
			flexDirection="column"
		>
			{lines.map((line, index) => {
				const color =
					line.kind === "added"
						? theme.colors.success
						: line.kind === "removed"
							? theme.colors.error
							: line.kind === "header"
								? theme.colors.primary
								: theme.colors.foreground;
				return (
					<text fg={color} key={`${index}-${line.text}`}>
						{line.text}
					</text>
				);
			})}
		</box>
	);
}

import { z } from "zod";
import type { NativeArtifactObservation } from "./native-artifact-observation.ts";
import { nativeSdkSchemaAdmits } from "./utils/native-sdk-admission.ts";

const nativeTextSchema = z.string();

import { artifactFromInput } from "./tools/artifact-tool.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./utils/native-sdk-observation.ts";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer.ts";

/** The two places an agent-authored JSON UI can live in the transcript. */
export type JsonRenderPlacement = "inline" | "turn-end";
export type AgentUiFormat = "json-render" | "a2ui";

interface EditStats {
	deletions: number;
	insertions: number;
}
export interface EditedFile {
	deletions: number;
	insertions: number;
	path: string;
}

export interface ReversibleTextEdit {
	after: string;
	before: string;
	kind: "replace";
	path: string;
}

export interface FileEditUndoPlan {
	edits: ReversibleTextEdit[];
	kind: "text-replacements";
}

export interface FileEditsTurnEndCard {
	files: EditedFile[];
	id: string;
	kind: "file-edits";
	undoPlan?: FileEditUndoPlan;
}

export interface JsonRenderTurnEndCard {
	format?: AgentUiFormat;
	id: string;
	kind: "json-render";
	spec: NativeSdkValue;
	title?: string;
	/** Source tool call, under which the widget's interactive state is saved. */
	toolCallId?: string;
}

export interface ArtifactTurnEndCard {
	artifact: NativeArtifactObservation;
	id: string;
	kind: "artifact";
	/** Source tool call. The card renders under the same artifact id as the
	 *  inline tool row (`artifact-<toolCallId>`), so a page's saved state carries
	 *  over when the card moves to the end of the turn. */
	toolCallId?: string;
}

export type TurnEndCard =
	| FileEditsTurnEndCard
	| JsonRenderTurnEndCard
	| ArtifactTurnEndCard;

const WRITE_TOOLS = new Set([
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
	"apply_patch",
	"create_file",
	"str_replace_editor",
]);

const PATH_KEYS = [
	"file_path",
	"filePath",
	"filename",
	"notebook_path",
	"notebookPath",
	"path",
] as const;

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const STAT_INSERTIONS = /\+(\d+)/;
const STAT_DELETIONS = /-(\d+)/;

/** Only fields actually read by the live SDK card projection; opaque future payloads remain untouched. */
interface RecordValue {
	command?: NativeSdkValue;
	content?: NativeSdkValue;
	diff?: NativeSdkValue;
	diff_stats?: NativeSdkValue;
	diffStats?: NativeSdkValue;
	edits?: NativeSdkValue;
	elements?: NativeSdkValue;
	errorText?: NativeSdkValue;
	file_path?: NativeSdkValue;
	filename?: NativeSdkValue;
	filePath?: NativeSdkValue;
	format?: NativeSdkValue;
	hunks?: NativeSdkValue;
	input?: NativeSdkValue;
	lines?: NativeSdkValue;
	new_str?: NativeSdkValue;
	new_string?: NativeSdkValue;
	notebook_path?: NativeSdkValue;
	notebookPath?: NativeSdkValue;
	old_content?: NativeSdkValue;
	old_str?: NativeSdkValue;
	old_string?: NativeSdkValue;
	output?: NativeSdkValue;
	patch?: NativeSdkValue;
	path?: NativeSdkValue;
	placement?: NativeSdkValue;
	replace_all?: NativeSdkValue;
	result?: NativeSdkValue;
	root?: NativeSdkValue;
	spec?: NativeSdkValue;
	state?: NativeSdkValue;
	structured_patch?: NativeSdkValue;
	structuredPatch?: NativeSdkValue;
	title?: NativeSdkValue;
	toolCallId?: NativeSdkValue;
	toolName?: NativeSdkValue;
	type?: NativeSdkValue;
}

function isRecord(value: NativeSdkValue): value is RecordValue {
	return nativeSdkSchemaAdmits(nativeSdkObjectSchema, value);
}
function isText(value: NativeSdkValue): value is string {
	return nativeSdkSchemaAdmits(nativeTextSchema, value);
}

function recordOf(value: NativeSdkValue): RecordValue {
	return isRecord(value) ? value : {};
}

function partToolName(part: NativeSdkValue): string {
	const value = recordOf(part);
	if (isText(value.toolName) && value.toolName.trim()) {
		return value.toolName.trim();
	}
	if (isText(value.type) && value.type.startsWith("tool-")) {
		return value.type.slice("tool-".length);
	}
	return "";
}

function partInput(part: NativeSdkValue): RecordValue {
	return recordOf(recordOf(part).input);
}

function partOutput(part: NativeSdkValue): RecordValue {
	const value = recordOf(part);
	return recordOf(value.output ?? value.result);
}

function firstString(...records: RecordValue[]): string | undefined {
	for (const record of records) {
		for (const key of PATH_KEYS) {
			const value = record[key];
			if (isText(value) && value.trim()) {
				return value.trim();
			}
		}
	}
	return undefined;
}

function lineCount(value: NativeSdkValue): number {
	if (!isText(value) || value.length === 0) {
		return 0;
	}
	return value.split(/\r?\n/).length;
}

function addStats(left: EditStats, right: EditStats): EditStats {
	return {
		deletions: left.deletions + right.deletions,
		insertions: left.insertions + right.insertions,
	};
}

function emptyStats(): EditStats {
	return { deletions: 0, insertions: 0 };
}

function addFile(
	files: Map<string, EditedFile>,
	path: string,
	stats: EditStats
): void {
	const normalizedPath = path.trim();
	if (!normalizedPath) {
		return;
	}
	const existing = files.get(normalizedPath);
	files.set(normalizedPath, {
		deletions: (existing?.deletions ?? 0) + stats.deletions,
		insertions: (existing?.insertions ?? 0) + stats.insertions,
		path: normalizedPath,
	});
}

function statsFromDiffText(value: NativeSdkValue): EditStats {
	if (!isText(value)) {
		return emptyStats();
	}
	const insertions = Number.parseInt(
		STAT_INSERTIONS.exec(value)?.[1] ?? "0",
		10
	);
	const deletions = Number.parseInt(STAT_DELETIONS.exec(value)?.[1] ?? "0", 10);
	return {
		deletions: Number.isFinite(deletions) ? deletions : 0,
		insertions: Number.isFinite(insertions) ? insertions : 0,
	};
}

function statsFromPatchText(value: NativeSdkValue): EditStats {
	if (!isText(value)) {
		return emptyStats();
	}
	let insertions = 0;
	let deletions = 0;
	for (const line of value.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			insertions += 1;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions += 1;
		}
	}
	return { deletions, insertions };
}

function statsFromStructuredPatch(value: NativeSdkValue): EditStats {
	if (isText(value)) {
		return statsFromPatchText(value);
	}
	if (!Array.isArray(value)) {
		return emptyStats();
	}
	let stats = emptyStats();
	for (const entry of value) {
		if (isText(entry)) {
			stats = addStats(stats, statsFromPatchText(entry));
			continue;
		}
		if (!isRecord(entry)) {
			continue;
		}
		const lines = entry.lines ?? entry.diff ?? entry.patch;
		if (lines !== undefined) {
			stats = addStats(stats, statsFromStructuredPatch(lines));
		}
		if (Array.isArray(entry.hunks)) {
			stats = addStats(stats, statsFromStructuredPatch(entry.hunks));
		}
	}
	return stats;
}

function editStats(
	tool: string,
	input: RecordValue,
	output: RecordValue
): EditStats {
	const diffStats = [
		input.diffStats,
		input.diff_stats,
		output.diffStats,
		output.diff_stats,
	]
		.map(statsFromDiffText)
		.find((stats) => stats.insertions > 0 || stats.deletions > 0);
	if (diffStats) {
		return diffStats;
	}

	const structuredPatch =
		input.structuredPatch ??
		input.structured_patch ??
		output.structuredPatch ??
		output.structured_patch;
	const structuredStats = statsFromStructuredPatch(structuredPatch);
	if (structuredStats.insertions > 0 || structuredStats.deletions > 0) {
		return structuredStats;
	}

	if (tool === "Write" || tool === "create_file") {
		return {
			deletions: 0,
			insertions: lineCount(input.content ?? output.content),
		};
	}

	if (tool === "Edit" || tool === "str_replace_editor") {
		return {
			deletions: lineCount(input.old_string ?? input.old_str),
			insertions: lineCount(input.new_string ?? input.new_str),
		};
	}

	return emptyStats();
}

function recordPatchFiles(
	files: Map<string, EditedFile>,
	patch: NativeSdkValue
): boolean {
	if (!isText(patch)) {
		return false;
	}
	let currentPath: string | undefined;
	let found = false;
	for (const line of patch.split(/\r?\n/)) {
		const header = PATCH_FILE.exec(line);
		if (header?.[1]) {
			currentPath = header[1].trim();
			addFile(files, currentPath, emptyStats());
			found = true;
			continue;
		}
		if (!currentPath) {
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			addFile(files, currentPath, { deletions: 0, insertions: 1 });
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			addFile(files, currentPath, { deletions: 1, insertions: 0 });
		}
	}
	return found;
}

function addMultiEditFiles(
	files: Map<string, EditedFile>,
	tool: string,
	input: RecordValue,
	output: RecordValue
): boolean {
	if (!Array.isArray(input.edits)) {
		return false;
	}
	let found = false;
	const fallbackPath = firstString(input, output);
	for (const edit of input.edits) {
		if (!isRecord(edit)) {
			continue;
		}
		const path = firstString(edit, input, output);
		if (!path) {
			continue;
		}
		addFile(files, path, {
			deletions: lineCount(edit.old_string ?? edit.old_str),
			insertions: lineCount(edit.new_string ?? edit.new_str ?? edit.content),
		});
		found = true;
	}
	if (!found && fallbackPath) {
		addFile(files, fallbackPath, editStats(tool, input, output));
		return true;
	}
	return found;
}

function isFailedPart(part: NativeSdkValue): boolean {
	const value = recordOf(part);
	return (
		value.state === "output-error" ||
		(isText(value.errorText) && value.errorText.trim().length > 0)
	);
}

function isIncompletePart(part: NativeSdkValue): boolean {
	const state = recordOf(part).state;
	return ["input-available", "input-streaming", "streaming"].includes(
		String(state)
	);
}

/** Extract the completed file writes/edits represented by one assistant turn. */
export function deriveEditedFiles(
	parts: NativeSdkValue[] | null | undefined
): EditedFile[] {
	const files = new Map<string, EditedFile>();
	const normalizedParts = normalizeAssistantToolParts(parts ?? []);
	for (const part of normalizedParts) {
		const tool = partToolName(part);
		if (
			!WRITE_TOOLS.has(tool) ||
			isFailedPart(part) ||
			isIncompletePart(part)
		) {
			continue;
		}
		const input = partInput(part);
		const output = partOutput(part);
		if (tool === "apply_patch") {
			const patch = input.patch ?? input.diff ?? output.patch ?? output.diff;
			if (recordPatchFiles(files, patch)) {
				continue;
			}
		}
		if (
			(tool === "MultiEdit" || tool === "NotebookEdit") &&
			addMultiEditFiles(files, tool, input, output)
		) {
			continue;
		}
		const path = firstString(input, output);
		if (path) {
			addFile(files, path, editStats(tool, input, output));
		}
	}
	return [...files.values()];
}

function reversibleTextEdit({
	after,
	before,
	path,
}: {
	after: NativeSdkValue;
	before: NativeSdkValue;
	path: string | undefined;
}): ReversibleTextEdit | undefined {
	if (
		!(path && isText(before) && isText(after)) ||
		after.length === 0 ||
		after === before
	) {
		return undefined;
	}
	return { after, before, kind: "replace", path };
}

function explicitOutputEdit(
	input: RecordValue,
	output: RecordValue
): ReversibleTextEdit | undefined {
	return reversibleTextEdit({
		after: output.content,
		before: output.old_content,
		path: firstString(output, input),
	});
}

function singleInputEdit(
	tool: string,
	input: RecordValue,
	output: RecordValue
): ReversibleTextEdit | undefined {
	if (input.replace_all === true) {
		return undefined;
	}
	if (
		tool === "str_replace_editor" &&
		isText(input.command) &&
		input.command !== "str_replace"
	) {
		return undefined;
	}
	return reversibleTextEdit({
		after: input.new_string ?? input.new_str,
		before: input.old_string ?? input.old_str,
		path: firstString(input, output),
	});
}

function multiInputEdits(
	input: RecordValue,
	output: RecordValue
): ReversibleTextEdit[] | undefined {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		return undefined;
	}
	const edits: ReversibleTextEdit[] = [];
	for (const rawEdit of input.edits) {
		if (!isRecord(rawEdit) || rawEdit.replace_all === true) {
			return undefined;
		}
		const edit = reversibleTextEdit({
			after: rawEdit.new_string ?? rawEdit.new_str,
			before: rawEdit.old_string ?? rawEdit.old_str,
			path: firstString(rawEdit, input, output),
		});
		if (!edit) {
			return undefined;
		}
		edits.push(edit);
	}
	return edits;
}

/** Build an exact text-replacement reversal only when the whole turn is safe. */
export function deriveUndoPlan(
	parts: NativeSdkValue[] | null | undefined
): FileEditUndoPlan | undefined {
	const normalizedParts = normalizeAssistantToolParts(parts ?? []);
	const edits: ReversibleTextEdit[] = [];
	let foundWrite = false;
	for (const part of normalizedParts) {
		const tool = partToolName(part);
		if (
			!WRITE_TOOLS.has(tool) ||
			isFailedPart(part) ||
			isIncompletePart(part)
		) {
			continue;
		}
		foundWrite = true;
		const input = partInput(part);
		const output = partOutput(part);
		const outputEdit = explicitOutputEdit(input, output);
		if (outputEdit) {
			edits.push(outputEdit);
			continue;
		}
		if (tool === "MultiEdit") {
			const multiEdits = multiInputEdits(input, output);
			if (!multiEdits) {
				return undefined;
			}
			edits.push(...multiEdits);
			continue;
		}
		if (tool === "Edit" || tool === "str_replace_editor") {
			const edit = singleInputEdit(tool, input, output);
			if (!edit) {
				return undefined;
			}
			edits.push(edit);
			continue;
		}
		return undefined;
	}
	if (!foundWrite || edits.length === 0) {
		return undefined;
	}
	return { edits, kind: "text-replacements" };
}

function isUiRenderPart(part: NativeSdkValue): boolean {
	const value = recordOf(part);
	return (
		value.type === "tool-ui.render" ||
		(value.type === "dynamic-tool" && value.toolName === "ui.render")
	);
}

function isArtifactRenderPart(part: NativeSdkValue): boolean {
	const value = recordOf(part);
	return (
		value.type === "tool-artifact.render" ||
		(value.type === "dynamic-tool" && value.toolName === "artifact.render")
	);
}

function isRenderableSpec(
	value: NativeSdkValue,
	format?: AgentUiFormat
): boolean {
	if (format === "a2ui") {
		return Array.isArray(value) || isText(value) || isRecord(value);
	}
	if (!isRecord(value)) {
		return false;
	}
	return isText(value.root) && isRecord(value.elements);
}

function formatOf(part: NativeSdkValue): AgentUiFormat | undefined {
	const format = partInput(part).format;
	return format === "json-render" || format === "a2ui" ? format : undefined;
}

function titleOf(value: NativeSdkValue): string | undefined {
	if (!isText(value)) {
		return undefined;
	}
	const title = value.trim();
	return title ? title.slice(0, 120) : undefined;
}

function placementOf(part: NativeSdkValue): JsonRenderPlacement {
	return partInput(part).placement === "turn-end" ? "turn-end" : "inline";
}

export function isTurnEndJsonRenderPart(part: NativeSdkValue): boolean {
	const parsedPart = part;
	const input = partInput(parsedPart);
	const format = formatOf(parsedPart);
	return (
		isUiRenderPart(parsedPart) &&
		!isIncompletePart(parsedPart) &&
		placementOf(parsedPart) === "turn-end" &&
		isRenderableSpec(input.spec, format)
	);
}

export function isTurnEndArtifactPart(part: NativeSdkValue): boolean {
	const parsedPart = part;
	return (
		isArtifactRenderPart(parsedPart) &&
		!isIncompletePart(parsedPart) &&
		partInput(parsedPart).placement === "turn-end" &&
		artifactFromInput(partInput(parsedPart)) !== null
	);
}

/** True for edit tool parts that are represented by the completed file card. */
export function isEditedFilePart(part: NativeSdkValue): boolean {
	const parsedPart = part;
	return (
		WRITE_TOOLS.has(partToolName(parsedPart)) &&
		!isFailedPart(parsedPart) &&
		!isIncompletePart(parsedPart)
	);
}

/** True when the part will be represented by a completed end-of-turn card. */
export function isTurnEndCardPart(part: NativeSdkValue): boolean {
	const parsedPart = part;
	return (
		isTurnEndJsonRenderPart(parsedPart) || isTurnEndArtifactPart(parsedPart)
	);
}

/**
 * Build the durable cards for one assistant turn. The input is the persisted
 * message parts, so reopening a conversation reconstructs exactly the same
 * cards without a second server-side summary channel.
 */
export function deriveTurnEndCards(
	parts: NativeSdkValue[] | null | undefined,
	sourceId = "turn"
): TurnEndCard[] {
	const normalizedParts = normalizeAssistantToolParts(parts ?? []);
	const cards: TurnEndCard[] = [];
	const files = deriveEditedFiles(normalizedParts);
	if (files.length > 0) {
		const undoPlan = deriveUndoPlan(normalizedParts);
		const card: FileEditsTurnEndCard = {
			files,
			id: `${sourceId}-edited-files`,
			kind: "file-edits",
		};
		if (undoPlan) {
			card.undoPlan = undoPlan;
		}
		cards.push(card);
	}

	for (const [index, part] of normalizedParts.entries()) {
		if (isTurnEndJsonRenderPart(part)) {
			const input = partInput(part);
			const format = formatOf(part);
			const formatFields: Pick<JsonRenderTurnEndCard, "format"> = {};
			if (format) {
				formatFields.format = format;
			}
			const toolCallId = recordOf(part).toolCallId;
			const card: JsonRenderTurnEndCard = {
				...formatFields,
				id: `${sourceId}-json-${index}`,
				kind: "json-render",
				spec: input.spec,
				title: titleOf(input.title),
			};
			if (isText(toolCallId) && toolCallId) {
				card.toolCallId = toolCallId;
			}
			cards.push(card);
			continue;
		}
		if (isTurnEndArtifactPart(part)) {
			const artifact = artifactFromInput(partInput(part));
			if (artifact) {
				const card: ArtifactTurnEndCard = {
					artifact,
					id: `${sourceId}-artifact-${index}`,
					kind: "artifact",
				};
				const toolCallId = recordOf(part).toolCallId;
				if (isText(toolCallId) && toolCallId) {
					card.toolCallId = toolCallId;
				}
				cards.push(card);
			}
		}
	}
	return cards;
}

/** Used by Detail=None so a turn-end result card remains visible after tool rows hide. */
export function hasTurnEndCards(
	parts: NativeSdkValue[] | null | undefined
): boolean {
	return deriveTurnEndCards(parts).length > 0;
}

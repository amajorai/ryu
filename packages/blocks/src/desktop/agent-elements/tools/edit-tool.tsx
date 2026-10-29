import { FileDiff } from "@ryu/ui/components/agents/file-diff";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { Pencil } from "lucide-react";
import { memo, useMemo } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import { diffLines } from "../utils/diff-lines.ts";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";
import {
	mapToolInvocationToStep,
	mapToolStateToStepState,
} from "../utils/tool-adapters.ts";
import styles from "./edit-tool.module.css";
import {
	type ToolApproval,
	ToolApprovalFooter,
} from "./tool-approval-footer.tsx";

export interface EditToolDiffCardProps {
	approval?: ToolApproval;
	input?: { old_string?: NativeSdkValue; new_string?: NativeSdkValue };
	isCollapsible?: boolean;
	onComplete: () => void;
	output?: {
		path?: NativeSdkValue;
		old_content?: NativeSdkValue;
		content?: NativeSdkValue;
	};
	state: StepState;
	step: Extract<TimelineStep, { type: "tool-call" }>;
}

export { diffLines };

/** Derive the language hint for the diff from the file extension. */
function languageForFile(
	fileName: string
): "typescript" | "json" | "bash" | "diff" | "tsx" | "text" {
	const ext = fileName.split(".").pop()?.toLowerCase();
	if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
		return "tsx";
	}
	if (ext === "json") {
		return "json";
	}
	if (ext === "sh" || ext === "bash" || ext === "zsh") {
		return "bash";
	}
	return "diff";
}

export function EditToolDiffCard({
	step,
	state,
	onComplete,
	input,
	output,
	isCollapsible = false,
	approval,
}: EditToolDiffCardProps) {
	useToolComplete(state === "animating", step.duration, onComplete);
	const isPending = state === "animating";
	const outputPath = isNativeText(output?.path) ? output.path : undefined;
	const fileName =
		step.filePath?.split("/").pop() ??
		outputPath?.split("/").pop() ??
		step.toolDetail;
	const hasFileName = Boolean(fileName);
	const isWrite = step.toolName === "Write";

	// Resolve old/new contents the same way the legacy @pierre/diffs path did:
	// prefer the part's own old/new strings, then the step's parsed diff lines.
	const diff = useMemo(() => {
		const oldFromOutput = isNativeText(output?.old_content)
			? output.old_content
			: undefined;
		const newFromOutput = isNativeText(output?.content)
			? output.content
			: undefined;
		const oldFromInput =
			!oldFromOutput && isNativeText(input?.old_string)
				? input.old_string
				: undefined;
		const newFromInput =
			!newFromOutput && isNativeText(input?.new_string)
				? input.new_string
				: undefined;

		const fallbackOld = step.diffLines
			?.filter((line) => line.type !== "add")
			.map((line) => line.content)
			.join("\n");
		const fallbackNew = step.diffLines
			?.filter((line) => line.type !== "remove")
			.map((line) => line.content)
			.join("\n");

		const oldContents = oldFromInput ?? oldFromOutput ?? fallbackOld ?? "";
		const newContents = newFromInput ?? newFromOutput ?? fallbackNew ?? "";

		if (!(oldContents || newContents)) {
			return null;
		}
		return {
			file: fileName ?? "file",
			lines: diffLines(oldContents, newContents),
		};
	}, [fileName, input, output, step.diffLines]);

	const pendingTitle = isWrite
		? isPending
			? "Creating"
			: "Created"
		: isPending
			? "Editing"
			: "Edited";

	return (
		<div className={styles.card}>
			{diff ? (
				<FileDiff
					collapseOnComplete={isCollapsible && !isPending}
					defaultOpen={!isCollapsible || isPending}
					file={hasFileName ? fileName : "file"}
					icon={<Pencil aria-hidden className="size-4" />}
					language={languageForFile(fileName ?? "file")}
					lines={diff.lines}
					maxHeight={360}
					status={isPending ? "streaming" : "complete"}
				/>
			) : (
				<span className="text-muted-foreground text-sm">
					{pendingTitle} {fileName}
				</span>
			)}
			{approval && <ToolApprovalFooter isPending={isPending} {...approval} />}
		</div>
	);
}

export interface EditToolProps {
	/**
	 * When true, the diff renders expanded regardless of `isCollapsible`.
	 * Driven by the "Show file edits" display pref.
	 */
	expandByDefault?: boolean;
	isCollapsible?: boolean;
	part: any;
}

export const EditTool = memo(function EditTool({
	part,
	isCollapsible = false,
	expandByDefault = false,
}: EditToolProps) {
	const approval = part.input?.approval ?? part.args?.approval;
	const toolName = part.type?.replace("tool-", "") || "Edit";
	const step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "edit", {
		toolName,
		args: part.input ?? part.args ?? {},
		state:
			part.state === "output-available"
				? "result"
				: part.state === "input-streaming"
					? "partial-call"
					: "call",
		result: part.output ?? part.result,
	});
	const stepState = mapToolStateToStepState(
		part.state === "output-available"
			? "result"
			: part.state === "input-streaming"
				? "partial-call"
				: "call"
	);
	const noop = () => {};

	return (
		<EditToolDiffCard
			approval={approval}
			input={part.input ?? part.args}
			isCollapsible={expandByDefault ? false : isCollapsible}
			onComplete={noop}
			output={part.output ?? part.result}
			state={stepState}
			step={step}
		/>
	);
});

import { type FileContents, MultiFileDiff } from "@pierre/diffs/react";
import { Button } from "@ryu/ui/components/button";
import { IconChevronDown } from "@tabler/icons-react";
import React, { memo } from "react";
import { useToolComplete } from "../hooks/use-tool-complete.ts";
import { FileExtIcon } from "../icons/file-ext-icon.tsx";
import { TextShimmer } from "../text-shimmer.tsx";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import {
	mapToolInvocationToStep,
	mapToolStateToStepState,
} from "../utils/tool-adapters.ts";
import {
	type ToolApproval,
	ToolApprovalFooter,
} from "./tool-approval-footer.tsx";

export interface EditToolDiffCardProps {
	approval?: ToolApproval;
	input?: Record<string, unknown>;
	isCollapsible?: boolean;
	onComplete: () => void;
	output?: Record<string, unknown>;
	state: StepState;
	step: Extract<TimelineStep, { type: "tool-call" }>;
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
	const outputPath = typeof output?.path === "string" ? output.path : undefined;
	const fileName =
		step.filePath?.split("/").pop() ??
		outputPath?.split("/").pop() ??
		step.toolDetail;
	const hasFileName = Boolean(fileName);
	const isWrite = step.toolName === "Write";
	const [themeType, setThemeType] = React.useState<"light" | "dark">("light");
	const [isExpanded, setIsExpanded] = React.useState(!isCollapsible);

	React.useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const updateTheme = () => {
			const isDark = document.documentElement.classList.contains("dark");
			setThemeType(isDark ? "dark" : "light");
		};
		updateTheme();

		const observer = new MutationObserver(updateTheme);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		return () => {
			observer.disconnect();
		};
	}, []);

	React.useEffect(() => {
		setIsExpanded(!isCollapsible);
	}, [isCollapsible]);

	const diffFiles = React.useMemo(() => {
		const fileLabel = fileName || "file";
		const oldFromOutput =
			typeof output?.old_content === "string" ? output.old_content : undefined;
		const newFromOutput =
			typeof output?.content === "string" ? output.content : undefined;
		const oldFromInput =
			!oldFromOutput && typeof input?.old_string === "string"
				? input.old_string
				: undefined;
		const newFromInput =
			!newFromOutput && typeof input?.new_string === "string"
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

		const oldFile: FileContents = {
			name: fileLabel,
			contents: oldContents,
		};
		const newFile: FileContents = {
			name: fileLabel,
			contents: newContents,
		};

		return { oldFile, newFile };
	}, [fileName, input, output, step.diffLines]);

	const diffCssVars = React.useMemo(
		() =>
			themeType === "dark"
				? ({
						"--diffs-bg": "#000",
						"--diffs-bg-buffer-override": "#000",
						"--diffs-bg-context-override": "#000",
						"--diffs-bg-hover-override": "#0a0a0a",
						"--diffs-bg-separator-override": "#0f0f0f",
					} as React.CSSProperties)
				: undefined,
		[themeType]
	);

	const diffUnsafeCss = React.useMemo(
		() =>
			themeType === "dark"
				? `
[data-diff],
[data-file],
[data-diffs-header],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: #000;
  --diffs-bg-buffer-override: #000;
  --diffs-bg-context-override: #000;
  --diffs-bg-hover-override: #0a0a0a;
  --diffs-bg-separator-override: #0f0f0f;
}
`
				: undefined,
		[themeType]
	);

	const diffClassName =
		"an-edit-diff dark:bg-black dark:[--diffs-bg:#000] dark:[--diffs-bg-buffer-override:#000] dark:[--diffs-bg-context-override:#000] dark:[--diffs-bg-hover-override:#0a0a0a] dark:[--diffs-bg-separator-override:#0f0f0f]";

	return (
		<div className="an-edit-tool-card overflow-hidden rounded-[var(--radius)] bg-muted dark:bg-black">
			<div className="flex h-7 items-center justify-between bg-muted px-2.5 py-0">
				<div className="flex min-w-0 items-center gap-1.5">
					{hasFileName && (
						<FileExtIcon className="h-3 w-3 shrink-0" filename={fileName} />
					)}
					{isPending && !diffFiles ? (
						<TextShimmer as="span" className="text-xs" duration={1.2}>
							Generating...
						</TextShimmer>
					) : isPending ? (
						<TextShimmer as="span" className="text-xs" duration={1.2}>
							{isWrite ? "Creating" : "Editing"} {fileName}
						</TextShimmer>
					) : (
						<span className="truncate text-muted-foreground text-xs">
							{isWrite ? "Created" : "Edited"} {fileName}
						</span>
					)}
				</div>
				{step.diffStats && !isPending && (
					<span className="inline-flex gap-2 font-mono text-[11px] text-muted-foreground">
						{step.diffStats.split(" ").map((token) => (
							<span
								className={
									token.startsWith("+")
										? "text-emerald-600 dark:text-emerald-400"
										: token.startsWith("-")
											? "text-red-600 dark:text-red-400"
											: undefined
								}
								key={token}
							>
								{token}
							</span>
						))}
					</span>
				)}
			</div>
			{diffFiles ? (
				<div className={`${diffClassName} text-[12px]`} style={diffCssVars}>
					<div
						className={isCollapsible ? "group/edit-diff relative" : "relative"}
					>
						<div
							className={
								isCollapsible && !isExpanded
									? "max-h-[260px] overflow-hidden"
									: undefined
							}
						>
							<MultiFileDiff
								className={diffClassName}
								key={themeType}
								newFile={diffFiles.newFile}
								oldFile={diffFiles.oldFile}
								options={{
									theme: { dark: "github-dark", light: "github-light" },
									themeType,
									unsafeCSS: diffUnsafeCss,
									diffStyle: "unified",
									disableFileHeader: true,
								}}
								style={diffCssVars}
							/>
						</div>
						{isCollapsible && (
							<Button
								aria-label={isExpanded ? "Hide" : "Show more"}
								className={
									"group absolute inset-x-0 bottom-0 flex h-16 items-end justify-center pb-2 text-muted-foreground hover:bg-transparent hover:text-foreground" +
									(isExpanded
										? "bg-transparent"
										: "bg-linear-to-b from-transparent to-background")
								}
								onClick={() => setIsExpanded((prev) => !prev)}
								type="button"
								variant="ghost"
							>
								<IconChevronDown
									className={
										"h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" +
										(isExpanded ? "rotate-180" : "rotate-0")
									}
								/>
							</Button>
						)}
					</div>
				</div>
			) : null}
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
	const approval = (part.input?.approval ?? part.args?.approval) as
		| ToolApproval
		| undefined;
	const toolName = (part.type as string)?.replace("tool-", "") || "Edit";
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

"use client";

// Approval card parts: status helpers, question options and progress dots.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/motion/checkbox.tsx";
import { Input } from "@ryu/ui/components/motion/input.tsx";
import {
	RadioGroup,
	RadioGroupItem,
} from "@ryu/ui/components/motion/radio.tsx";
import { SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion } from "motion/react";
import type {
	ApprovalCardAnswer,
	ApprovalCardQuestion,
	ApprovalCardStatus,
} from "./types.ts";

export const EMPTY_ANSWER: ApprovalCardAnswer = { selected: [], custom: "" };

export function getStatusLabel(status: ApprovalCardStatus) {
	if (status === "submitting") {
		return "Submitting";
	}
	if (status === "approved") {
		return "Approved";
	}
	if (status === "rejected") {
		return "Rejected";
	}
	if (status === "changes-requested") {
		return "Changes requested";
	}
	if (status === "answered") {
		return "Response submitted";
	}
	return "Input required";
}

export function getStatusClass(status: ApprovalCardStatus) {
	if (status === "approved" || status === "answered") {
		return "text-status-success";
	}
	if (status === "rejected") {
		return "text-status-destructive";
	}
	if (status === "changes-requested") {
		return "text-status-warning";
	}
	return "text-muted-foreground";
}

// The header label keeps the old badge's tones as text: "Input required"
// still reads as needing attention, while the leading icon stays muted.
export function getStatusLabelClass(status: ApprovalCardStatus) {
	if (status === "pending") {
		return "text-status-warning";
	}
	return getStatusClass(status);
}

export function isAnswered(answer: ApprovalCardAnswer) {
	return answer.selected.length > 0 || Boolean(answer.custom?.trim());
}

export function QuestionOptions({
	question,
	answer,
	disabled,
	onChange,
	onSingleSelect,
}: {
	question: ApprovalCardQuestion;
	answer: ApprovalCardAnswer;
	disabled: boolean;
	onChange: (answer: ApprovalCardAnswer) => void;
	onSingleSelect?: () => void;
}) {
	const custom = answer.custom ?? "";

	return (
		<div className="mt-3">
			{question.options?.length ? (
				question.multiple ? (
					<div className="grid gap-0.5">
						{question.options.map((option) => (
							<Checkbox
								checked={answer.selected.includes(option.value)}
								className="min-h-9 rounded-lg px-1.5 py-1"
								disabled={disabled || option.disabled}
								key={option.value}
								label={option.label}
								onCheckedChange={(checked) =>
									onChange({
										...answer,
										selected: checked
											? [...answer.selected, option.value]
											: answer.selected.filter(
													(value) => value !== option.value
												),
									})
								}
							/>
						))}
					</div>
				) : (
					<RadioGroup
						className="gap-0.5"
						onValueChange={(value) => {
							onChange({ selected: [value], custom: "" });
							onSingleSelect?.();
						}}
						value={answer.selected[0] ?? ""}
					>
						{question.options.map((option) => (
							<RadioGroupItem
								className="min-h-9 rounded-lg px-1.5 py-1"
								disabled={disabled || option.disabled}
								key={option.value}
								label={option.label}
								value={option.value}
							/>
						))}
					</RadioGroup>
				)
			) : null}

			{question.allowCustom ? (
				<Input
					className={cn("p-0.5", question.options?.length && "mt-1.5")}
					classNames={{
						field: "h-10 rounded-lg border-0 bg-background",
						input: "px-3 text-sm",
					}}
					disabled={disabled}
					onChange={(value) =>
						onChange({
							selected: question.multiple ? answer.selected : [],
							custom: value,
						})
					}
					placeholder={question.customPlaceholder ?? "Add another response…"}
					value={custom}
				/>
			) : null}
		</div>
	);
}

export function ProgressDots({
	current,
	ids,
}: {
	current: number;
	ids: string[];
}) {
	const tl = useLiteralMessages();
	const n = { count: ids.length, number: current + 1 };
	return (
		<span className="flex gap-1.5">
			<span className="sr-only">{tl("Question {number} of {count}", n)}</span>
			{ids.map((id, index) => (
				<motion.span
					animate={{
						scale: index === current ? 1 : 0.75,
						opacity: index <= current ? 1 : 0.35,
					}}
					aria-hidden="true"
					className="size-1.5 rounded-full bg-foreground"
					initial={{
						scale: index === current ? 1 : 0.75,
						opacity: index <= current ? 1 : 0.35,
					}}
					key={id}
					transition={SPRING_SWAP}
				/>
			))}
		</span>
	);
}

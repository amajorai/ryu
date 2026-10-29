// beui.dev/components/agents/approval-card
import type { ReactNode } from "react";

export type ApprovalCardStatus =
	| "pending"
	| "submitting"
	| "approved"
	| "rejected"
	| "changes-requested"
	| "answered";

export interface ApprovalCardOption {
	disabled?: boolean;
	label: string;
	value: string;
}

export interface ApprovalCardQuestion {
	allowCustom?: boolean;
	autoAdvance?: boolean;
	customPlaceholder?: string;
	description?: ReactNode;
	id: string;
	multiple?: boolean;
	options?: ApprovalCardOption[];
	title: ReactNode;
}

export interface ApprovalCardAnswer {
	custom?: string;
	selected: string[];
}

export type ApprovalCardAnswers = Record<string, ApprovalCardAnswer>;

export interface ApprovalCardProps {
	answers?: ApprovalCardAnswers;
	appearance?: "default" | "docs";
	approveLabel?: ReactNode;
	children?: ReactNode;
	className?: string;
	defaultAnswers?: ApprovalCardAnswers;
	defaultStep?: number;
	description?: ReactNode;
	onAnswersChange?: (answers: ApprovalCardAnswers) => void;
	onApprove?: () => void;
	onDismiss?: () => void;
	onReject?: () => void;
	onRequestChanges?: () => void;
	onStepChange?: (step: number) => void;
	onSubmit?: (answers: ApprovalCardAnswers) => void;
	questions?: ApprovalCardQuestion[];
	result?: ReactNode;
	status?: ApprovalCardStatus;
	step?: number;
	submitLabel?: ReactNode;
	title?: ReactNode;
}

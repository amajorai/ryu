"use client";

// beui.dev/components/agents/tool-approval

import {
	AgentCode,
	type AgentCodeLanguage,
} from "@ryu/ui/components/agents/agent-code.tsx";
import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { EASE_OUT, SPRING_PRESS, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Check,
	ChevronDown,
	CircleAlert,
	LoaderCircle,
	ShieldCheck,
	X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

export type ToolApprovalStatus =
	| "pending"
	| "approving"
	| "approved"
	| "denied"
	| "running"
	| "complete"
	| "error";

export interface ToolApprovalParameter {
	id: string;
	label: ReactNode;
	value: ReactNode;
}

/**
 * One button in the decision row. Modelled on an ACP permission option rather
 * than a fixed allow/deny pair, so an agent that offers four choices gets four
 * buttons instead of silently losing two.
 */
export interface ToolApprovalChoice {
	id: string;
	label: ReactNode;
	onSelect?: () => void;
	tone?: "primary" | "secondary" | "ghost";
}

export interface ToolApprovalCodeProps {
	className?: string;
	code: string;
	language?: AgentCodeLanguage;
}

export interface ToolApprovalProps {
	children?: ReactNode;
	choices?: ToolApprovalChoice[];
	className?: string;
	defaultOpen?: boolean;
	description?: ReactNode;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	parameters?: ToolApprovalParameter[];
	question?: ReactNode;
	status?: ToolApprovalStatus;
	title?: ReactNode;
	tool: ReactNode;
}

const STATUS_COPY = {
	pending: "Approval required",
	approving: "Approving",
	approved: "Approved",
	denied: "Denied",
	running: "Running",
	complete: "Completed",
	error: "Failed",
} satisfies Record<ToolApprovalStatus, string>;

const PENDING_BADGE = "border-warning/30 bg-warning/10 text-status-warning";
const BUSY_BADGE = "border-info/30 bg-info/10 text-status-info";
const OK_BADGE = "border-success/30 bg-success/10 text-status-success";
const BAD_BADGE =
	"border-destructive/30 bg-destructive/10 text-status-destructive";

function getStatusBadgeClass(status: ToolApprovalStatus) {
	if (status === "pending") {
		return PENDING_BADGE;
	}
	if (status === "approving" || status === "running") {
		return BUSY_BADGE;
	}
	if (status === "approved" || status === "complete") {
		return OK_BADGE;
	}
	return BAD_BADGE;
}

const CHOICE_TONE_CLASS = {
	primary:
		"bg-foreground text-background focus-visible:ring-offset-2 hover:bg-foreground/90",
	secondary:
		"border border-border/60 bg-background text-foreground hover:bg-muted",
	ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
} satisfies Record<NonNullable<ToolApprovalChoice["tone"]>, string>;

function StatusIcon({
	status,
	reduce,
}: {
	reduce: boolean;
	status: ToolApprovalStatus;
}) {
	if (status === "approving" || status === "running") {
		return <LoaderCircle className={cn("size-4", !reduce && "animate-spin")} />;
	}
	if (status === "error") {
		return <CircleAlert className="size-4" />;
	}
	if (status === "denied") {
		return <X className="size-4" />;
	}
	if (status === "approved" || status === "complete") {
		return <Check className="size-4" />;
	}
	return <ShieldCheck className="size-4" />;
}

export interface ToolApprovalActionsProps {
	choices: ToolApprovalChoice[];
	className?: string;
	/** Only a `pending` request is answerable; anything else renders nothing. */
	status?: ToolApprovalStatus;
}

/**
 * The decision row on its own, for surfaces that already have a card around
 * them — a tool row's footer strip, where the full `ToolApproval` shell would
 * be a second border inside the first.
 */
export function ToolApprovalActions({
	choices,
	status = "pending",
	className,
}: ToolApprovalActionsProps) {
	const reduce = useReducedMotion() ?? false;

	return (
		<AnimatePresence initial={false}>
			{status === "pending" && choices.length ? (
				<motion.div
					animate={{ opacity: 1, y: 0 }}
					className={cn("flex flex-wrap items-center gap-1.5", className)}
					exit={{ opacity: 0 }}
					initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
					transition={{ duration: reduce ? 0.12 : 0.22, ease: EASE_OUT }}
				>
					{choices.map((choice) => (
						<motion.button
							className={cn(
								"rounded-lg px-2 py-0.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								CHOICE_TONE_CLASS[choice.tone ?? "ghost"]
							)}
							key={choice.id}
							onClick={choice.onSelect}
							transition={SPRING_PRESS}
							type="button"
							whileTap={reduce ? undefined : { scale: 0.97 }}
						>
							{choice.label}
						</motion.button>
					))}
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}

export function ToolApprovalCode({
	code,
	language = "bash",
	className,
}: ToolApprovalCodeProps) {
	return (
		<AgentCode
			className={cn(
				"rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2",
				className
			)}
			code={code}
			language={language}
		/>
	);
}

export function ToolApproval({
	tool,
	title = "Allow this tool to run?",
	description,
	parameters,
	choices,
	status = "pending",
	open,
	defaultOpen = false,
	onOpenChange,
	children,
	className,
	question,
}: ToolApprovalProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const detailsId = `${baseId}-details`;
	const previousStatus = useRef(status);
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const currentOpen = open ?? internalOpen;
	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) {
				setInternalOpen(next);
			}
			onOpenChange?.(next);
		},
		[onOpenChange, open]
	);
	const busy = status === "approving" || status === "running";
	const pending = status === "pending";
	const rows = parameters ?? [];
	const decisions = choices ?? [];

	// Collapse the details as soon as the question is answered — the parameters
	// mattered while deciding, not afterwards.
	useEffect(() => {
		if (previousStatus.current === "pending" && status !== "pending") {
			setOpen(false);
		}
		previousStatus.current = status;
	}, [setOpen, status]);

	return (
		<div
			aria-busy={busy}
			className={cn(
				"w-full overflow-hidden rounded-2xl border border-border/60 bg-muted/20 text-sm",
				className
			)}
			data-state={status}
		>
			<div className="flex items-start gap-3 p-4">
				<span
					aria-hidden="true"
					className={cn(
						"mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border border-border/60 bg-background text-muted-foreground",
						status === "error" && "text-status-destructive"
					)}
				>
					<StatusIcon reduce={reduce} status={status} />
				</span>

				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="font-medium text-foreground">{title}</div>
							<div className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
								{tool}
							</div>
						</div>
						<span
							className={cn(
								"type-caption shrink-0 rounded-full border px-2 py-0.5 font-medium transition-colors",
								getStatusBadgeClass(status)
							)}
						>
							{STATUS_COPY[status]}
						</span>
					</div>
					{question ? (
						<p className="mt-2 font-medium text-foreground leading-5">
							{question}
						</p>
					) : null}
					{description ? (
						<p className="mt-2 text-muted-foreground leading-5">
							{description}
						</p>
					) : null}

					{rows.length ? (
						<button
							aria-controls={detailsId}
							aria-expanded={currentOpen}
							className="mt-2 inline-flex items-center gap-1 rounded-md font-medium text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setOpen(!currentOpen)}
							type="button"
						>
							View details
							<motion.span
								animate={{ rotate: currentOpen ? 180 : 0 }}
								aria-hidden="true"
								transition={reduce ? { duration: 0 } : SPRING_SWAP}
							>
								<ChevronDown className="size-3.5" />
							</motion.span>
						</button>
					) : null}
				</div>
			</div>

			{children ? <div className="px-4 pb-4">{children}</div> : null}

			{rows.length ? (
				<AgentDisclosure id={detailsId} open={currentOpen}>
					<dl className="mx-4 mb-4 grid gap-2 rounded-xl border border-border/50 bg-background/70 p-3">
						{rows.map((parameter) => (
							<div
								className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3 text-xs"
								key={parameter.id}
							>
								<dt className="text-muted-foreground">{parameter.label}</dt>
								<dd className="min-w-0 break-words font-mono text-foreground/85">
									{parameter.value}
								</dd>
							</div>
						))}
					</dl>
				</AgentDisclosure>
			) : null}

			<AnimatePresence initial={false}>
				{pending && decisions.length ? (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						className="flex flex-wrap items-center gap-2 border-border/60 border-t px-4 py-3"
						exit={{ opacity: 0 }}
						initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
						transition={{ duration: reduce ? 0.12 : 0.22, ease: EASE_OUT }}
					>
						{decisions.map((choice) => (
							<motion.button
								className={cn(
									"rounded-xl px-3 py-1.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
									CHOICE_TONE_CLASS[choice.tone ?? "secondary"]
								)}
								key={choice.id}
								onClick={choice.onSelect}
								transition={SPRING_PRESS}
								type="button"
								whileTap={reduce ? undefined : { scale: 0.97 }}
							>
								{choice.label}
							</motion.button>
						))}
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

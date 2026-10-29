import { useLiteralMessages } from "@ryu/i18n/react";
import { EASE_OUT, SPRING_LAYOUT } from "@ryu/ui/lib/ease.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { safeHttpUrl } from "@ryu/ui/lib/safe-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Check,
	Circle,
	FileText,
	Globe2,
	ImageIcon,
	MessageSquare,
	PencilLine,
	Search,
	Sparkles,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { isNativeNumber } from "../../../lib/native-primitive-observation.ts";
import type {
	AgentActivityItem,
	AgentActivitySearch,
	AgentActivityStep,
	AgentActivityText,
	AgentActivityTool,
	AgentActivityTrace,
	AgentSearchResult,
} from "./types.ts";

function StepRow({ item }: { item: AgentActivityStep }) {
	const state = item.status ?? "complete";

	return (
		<div className="flex min-h-7 items-start gap-2.5 rounded-md px-1.5 py-1">
			<span
				aria-hidden="true"
				className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground/70"
			>
				{state === "complete" ? (
					<Check className="size-4" strokeWidth={1.8} />
				) : state === "active" ? (
					<span className="relative grid size-3 place-items-center">
						<motion.span
							animate={{ opacity: [0.35, 0.8, 0.35] }}
							className="absolute inset-0 rounded-full bg-foreground/10"
							transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY }}
						/>
						<span className="size-1.5 rounded-full bg-foreground/60" />
					</span>
				) : (
					<Circle className="size-3" strokeWidth={1.5} />
				)}
			</span>
			<span
				className={cn(
					"min-w-0 flex-1 leading-5",
					state === "pending"
						? "text-muted-foreground/55"
						: "text-foreground/90"
				)}
			>
				{item.label}
			</span>
			{item.meta ? (
				<span className="shrink-0 text-muted-foreground/55 leading-5">
					{item.meta}
				</span>
			) : null}
		</div>
	);
}

function TextRow({ item }: { item: AgentActivityText }) {
	return (
		<div className="rounded-md px-1.5 py-1 text-muted-foreground leading-5">
			{item.content}
		</div>
	);
}

function SearchResultRow({ result }: { result: AgentSearchResult }) {
	const safeUrl = safeHttpUrl(result.url);
	const content = (
		<>
			<span
				aria-hidden="true"
				className="grid size-5 shrink-0 place-items-center text-muted-foreground"
			>
				{result.icon ?? <Globe2 className="size-3" strokeWidth={2} />}
			</span>
			<span className="min-w-0 truncate font-medium text-foreground/90">
				{result.title}
			</span>
			{result.domain ? (
				<span className="min-w-0 truncate text-muted-foreground/55">
					{result.domain}
				</span>
			) : null}
		</>
	);
	const className = cn(
		"flex min-h-7 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
		safeUrl && "focus-visible:ring-2 focus-visible:ring-ring"
	);

	return safeUrl ? (
		<a
			className={className}
			href={safeUrl}
			rel="noopener noreferrer"
			target="_blank"
		>
			{content}
		</a>
	) : (
		<div className={className}>{content}</div>
	);
}

function SearchRow({ item }: { item: AgentActivitySearch }) {
	const tl = useLiteralMessages();
	const reduce = useReducedMotion() ?? false;
	const enter = reduce ? { opacity: 1 } : { opacity: 0, y: 6 };
	const visible = { opacity: 1, y: 0 };
	const exit = reduce ? { opacity: 0 } : { opacity: 0, y: -3 };
	const transition = reduce
		? { duration: 0 }
		: {
				opacity: { duration: 0.18, ease: EASE_OUT },
				y: SPRING_LAYOUT,
				layout: SPRING_LAYOUT,
			};

	return (
		<div className="space-y-0.5">
			<div className="flex min-h-7 items-center gap-2.5 rounded-md px-1.5 py-1 text-muted-foreground">
				<Search
					aria-hidden="true"
					className="size-4 shrink-0"
					strokeWidth={1.7}
				/>
				<span className="min-w-0 truncate">{item.query}</span>
			</div>
			{item.results?.length ? (
				<div className="space-y-0.5 pl-4">
					<AnimatePresence initial mode="popLayout">
						{item.results.map((result) => (
							<motion.div
								animate={visible}
								exit={exit}
								initial={enter}
								key={result.id}
								layout="position"
								transition={transition}
							>
								<SearchResultRow result={result} />
							</motion.div>
						))}
					</AnimatePresence>
				</div>
			) : null}
			<AnimatePresence initial>
				{item.moreCount ? (
					<motion.div
						animate={visible}
						className="px-1.5 py-1 pl-8 text-muted-foreground/55"
						exit={exit}
						initial={enter}
						key="more-results"
						transition={transition}
					>
						{tl("+{moreCount} more", { moreCount: String(item.moreCount) })}
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

function ActionIcon({ action }: { action: string }) {
	if (action === "read") {
		return <FileText className="size-4" />;
	}
	if (action === "edit" || action === "write") {
		return <PencilLine className="size-4" />;
	}
	if (action === "run") {
		return <SquareTerminal className="size-4" />;
	}
	return <Wrench className="size-4" />;
}

function ToolRow({ item }: { item: AgentActivityTool }) {
	const action = item.action.charAt(0).toUpperCase() + item.action.slice(1);

	return (
		<div className="flex min-h-8 min-w-0 items-center gap-2.5 rounded-md px-1.5 py-0.5 leading-5">
			<span
				aria-hidden="true"
				className="grid size-4 shrink-0 place-items-center text-muted-foreground/70"
			>
				<ActionIcon action={item.action} />
			</span>
			<span className="shrink-0 font-medium text-foreground/90">{action}</span>
			<span className="min-w-0 flex-1 truncate rounded-lg bg-muted/80 px-2.5 py-1 font-mono text-muted-foreground/70 text-xs">
				{item.target}
			</span>
			{isNativeNumber(item.additions) || isNativeNumber(item.deletions) ? (
				<span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
					{isNativeNumber(item.additions) ? (
						<span className="text-status-success">
							+{formatCount(item.additions) ?? "—"}
						</span>
					) : null}
					{isNativeNumber(item.deletions) ? (
						<span className="text-status-destructive">
							−{formatCount(item.deletions) ?? "—"}
						</span>
					) : null}
				</span>
			) : null}
		</div>
	);
}

function TraceIcon({ kind }: { kind: AgentActivityTrace["kind"] }) {
	if (kind === "thinking") {
		return <Sparkles className="size-4" />;
	}
	if (kind === "message") {
		return <MessageSquare className="size-4" />;
	}
	if (kind === "write") {
		return <PencilLine className="size-4" />;
	}
	if (kind === "run") {
		return <SquareTerminal className="size-4" />;
	}
	if (kind === "read") {
		return <ImageIcon className="size-4" />;
	}
	return <Wrench className="size-4" />;
}

function TraceRow({ item }: { item: AgentActivityTrace }) {
	return (
		<div className="grid min-h-8 grid-cols-[1rem_auto_minmax(0,1fr)] items-center gap-2.5 rounded-md px-1.5 py-0.5">
			<span
				aria-hidden="true"
				className="grid size-4 place-items-center text-muted-foreground/70"
			>
				{item.icon ?? <TraceIcon kind={item.kind} />}
			</span>
			<span className="font-medium text-foreground/90">{item.label}</span>
			{item.detail ? (
				<span className="min-w-0 truncate rounded-lg bg-muted/80 px-2.5 py-1 font-mono text-muted-foreground/70 text-xs">
					{item.detail}
				</span>
			) : (
				<span />
			)}
		</div>
	);
}

export function ActivityRow({ item }: { item: AgentActivityItem }) {
	if (item.type === "text") {
		return <TextRow item={item} />;
	}
	if (item.type === "search") {
		return <SearchRow item={item} />;
	}
	if (item.type === "tool") {
		return <ToolRow item={item} />;
	}
	if (item.type === "trace") {
		return <TraceRow item={item} />;
	}
	return <StepRow item={item} />;
}

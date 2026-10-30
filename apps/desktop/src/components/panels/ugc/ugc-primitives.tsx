import { Alert01Icon, LinkSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import ugcStyles from "../ugc.module.css";
import { formatCents, spendPercent } from "./ugc-format.ts";

export function StatusPill({
	label,
	variant,
}: {
	label: string;
	variant: ComponentProps<typeof Badge>["variant"];
}) {
	return (
		<Badge casing="capitalized" variant={variant}>
			{label}
		</Badge>
	);
}

export function StatTile({
	hint,
	label,
	value,
}: {
	hint?: string;
	label: string;
	value: string;
}) {
	return (
		<div className="rounded-xl border border-border bg-muted/20 px-3 py-2">
			<div className="text-detail text-muted-foreground">{label}</div>
			<div className="font-medium font-mono text-sm tabular-nums">{value}</div>
			{hint ? (
				<div className="text-muted-foreground text-xs">{hint}</div>
			) : null}
		</div>
	);
}

/** Spend against budget. An uncapped campaign gets the amount and an honest
 *  "no budget cap" rather than a bar that would imply a ceiling. */
interface SpendStyle extends CSSProperties {
	"--ugc-spend-width": string;
}

export function SpendBar({
	budgetCents,
	spentCents,
}: {
	budgetCents: number;
	spentCents: number;
}) {
	const pct = spendPercent(spentCents, budgetCents);
	const spendStyle: SpendStyle = { "--ugc-spend-width": `${pct}%` };
	if (pct === null) {
		return (
			<span className="text-muted-foreground text-xs">
				<span className="font-mono tabular-nums">
					{formatCents(spentCents)}
				</span>{" "}
				spent · no budget cap
			</span>
		);
	}
	return (
		<span className="flex items-center gap-2">
			<span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
				<span
					className={cn(
						"block h-full rounded-full",
						ugcStyles.spendFill,
						pct >= 100 ? "bg-destructive" : "bg-primary"
					)}
					style={spendStyle}
				/>
			</span>
			<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
				{formatCents(spentCents)} / {formatCents(budgetCents)}
			</span>
		</span>
	);
}

export function PanelNotice({
	children,
	tone = "muted",
}: {
	children: ReactNode;
	tone?: "error" | "muted";
}) {
	return (
		<p
			className={cn(
				"px-3 py-2 text-xs",
				tone === "error" ? "text-status-destructive" : "text-muted-foreground"
			)}
		>
			{children}
		</p>
	);
}

export function LoadingRow({ text = "Loading…" }: { text?: string }) {
	return <SkeletonRows label={text} size="sm" spacing="compact-panel" />;
}

export function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-status-destructive text-xs">
			<HugeiconsIcon className="mt-px size-3.5 shrink-0" icon={Alert01Icon} />
			<span className="min-w-0 break-words">{message}</span>
		</div>
	);
}

/** A post link. External and untrusted, so `noopener noreferrer` is mandatory. */
export function PostLink({ url }: { url: string }) {
	const safeUrl = safeHttpUrl(url);
	if (!safeUrl) {
		return null;
	}
	return (
		<a
			className="inline-flex items-center gap-1 text-primary hover:underline"
			href={safeUrl}
			rel="noopener noreferrer"
			target="_blank"
			title={safeUrl}
		>
			<HugeiconsIcon className="size-3.5" icon={LinkSquare01Icon} />
			<span
				className="max-w-40 truncate"
				title={safeUrl.replace(/^https?:\/\//, "")}
			>
				{safeUrl.replace(/^https?:\/\//, "")}
			</span>
		</a>
	);
}

/** Composio's "connect this account" link, offered only when it is an `https:`
 *  URL.
 *
 *  The value comes out of an upstream response and lands in an `href`, so a
 *  scheme this panel cannot vouch for (`javascript:`, `data:`) must never become
 *  clickable. Refusing the link and leaving the sidecar's message on its own is
 *  the honest fallback — the operator can still connect the account from
 *  Composio, and a link that is not offered cannot run anything. */
export function ConnectLink({ url }: { url: string | null | undefined }) {
	const safeUrl = safeHttpUrl(url);
	if (!safeUrl?.startsWith("https:")) {
		return null;
	}
	return (
		<a
			className="inline-flex items-center gap-1 text-primary hover:underline"
			href={safeUrl}
			rel="noopener noreferrer"
			target="_blank"
			title={safeUrl}
		>
			<HugeiconsIcon className="size-3.5" icon={LinkSquare01Icon} />
			Connect account
		</a>
	);
}

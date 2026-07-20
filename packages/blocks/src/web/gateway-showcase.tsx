"use client";

import {
	Activity,
	CircleDollarSign,
	GitBranch,
	KeyRound,
	Lock,
	ScrollText,
	Shield,
	ShieldCheck,
} from "lucide-react";
import type { ComponentType } from "react";
import { WindowFrame } from "./mockups.tsx";

/**
 * A static, non-interactive replica of the desktop app's Gateway dialog
 * (the "moat" surface). Rebuilt from the real desktop look — the two-pane
 * ResizableSettings layout, the up/down status badge, the bg-muted/40 MetricTile
 * grid, and the firewall verdict rows — using the same @ryu/ui theme tokens so it
 * matches the product pixel-for-pixel in light, dark, and midnight.
 */

type IconType = ComponentType<{ className?: string }>;

const NAV: { label: string; icon: IconType; active?: boolean }[] = [
	{ label: "Overview", icon: Activity, active: true },
	{ label: "Routing", icon: GitBranch },
	{ label: "Guardrails", icon: Shield },
	{ label: "Budgets", icon: CircleDollarSign },
	{ label: "Keys", icon: KeyRound },
	{ label: "Identities", icon: Lock },
	{ label: "Audit", icon: ScrollText },
];

const METRICS: { label: string; value: string; hint: string }[] = [
	{ label: "Requests", value: "12,481", hint: "last 24h" },
	{ label: "Errors", value: "0.2%", hint: "23 of 12,481" },
	{ label: "Cache hit rate", value: "41%", hint: "exact + semantic" },
	{ label: "Tokens", value: "8.9M", hint: "in + out" },
];

const VERDICTS: {
	label: string;
	detail: string;
	tone: "block" | "redact" | "allow";
}[] = [
	{
		label: "SQL injection",
		detail: "DROP TABLE users, blocked at request",
		tone: "block",
	},
	{
		label: "Prompt injection",
		detail: "“ignore previous instructions”, blocked",
		tone: "block",
	},
	{
		label: "PII / DLP",
		detail: "email + card number, redacted before egress",
		tone: "redact",
	},
	{
		label: "Routing",
		detail: "cheap prompt → local llama.cpp, hard → Claude",
		tone: "allow",
	},
];

const TONE_STYLES: Record<
	"block" | "redact" | "allow",
	{ dot: string; pill: string; text: string }
> = {
	block: {
		dot: "bg-destructive",
		pill: "bg-destructive/10 text-destructive",
		text: "Blocked",
	},
	redact: {
		dot: "bg-warning",
		pill: "bg-warning/10 text-warning",
		text: "Redacted",
	},
	allow: {
		dot: "bg-success",
		pill: "bg-success/10 text-success",
		text: "Allowed",
	},
};

function MetricTile({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint: string;
}) {
	return (
		<div className="rounded-lg bg-muted/40 p-3">
			<p className="text-muted-foreground text-xs">{label}</p>
			<p className="mt-1 font-semibold text-foreground text-lg tabular-nums">
				{value}
			</p>
			<p className="text-[10px] text-muted-foreground/70">{hint}</p>
		</div>
	);
}

export function GatewayMock() {
	return (
		<WindowFrame contentClassName="p-0" title="Ryu Gateway">
			<div className="flex min-h-[420px]">
				{/* Left nav */}
				<div className="hidden w-44 shrink-0 flex-col border-border border-r bg-muted/30 p-3 sm:flex">
					<p className="mb-2 px-2 font-medium text-[10px] text-muted-foreground uppercase tracking-widest">
						Gateway
					</p>
					{NAV.map((item) => (
						<div
							className={
								item.active
									? "flex items-center gap-2 rounded-md bg-foreground/10 px-2.5 py-1.5 font-medium text-foreground text-xs"
									: "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted-foreground text-xs"
							}
							key={item.label}
						>
							<item.icon className="size-3.5" />
							{item.label}
						</div>
					))}
				</div>

				{/* Content */}
				<div className="flex-1 space-y-4 p-4">
					<div className="flex items-center justify-between">
						<h3 className="font-semibold text-base text-foreground">
							Overview
						</h3>
						<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 font-medium text-[11px] text-success">
							<span className="size-1.5 rounded-full bg-success" />
							Up
						</span>
					</div>

					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						{METRICS.map((metric) => (
							<MetricTile
								hint={metric.hint}
								key={metric.label}
								label={metric.label}
								value={metric.value}
							/>
						))}
					</div>

					{/* Guardrail verdicts */}
					<div className="rounded-xl border border-border p-3">
						<div className="mb-2 flex items-center gap-2">
							<ShieldCheck className="size-4 text-muted-foreground" />
							<p className="font-medium text-foreground text-xs">
								Firewall &amp; DLP on every call, both planes
							</p>
						</div>
						<div className="space-y-1.5">
							{VERDICTS.map((verdict) => {
								const tone = TONE_STYLES[verdict.tone];
								return (
									<div
										className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2"
										key={verdict.label}
									>
										<span className={`size-1.5 rounded-full ${tone.dot}`} />
										<div className="min-w-0 flex-1">
											<p className="font-medium text-foreground text-xs">
												{verdict.label}
											</p>
											<p className="truncate text-[11px] text-muted-foreground">
												{verdict.detail}
											</p>
										</div>
										<span
											className={`shrink-0 rounded-md px-2 py-0.5 font-medium text-[10px] ${tone.pill}`}
										>
											{tone.text}
										</span>
									</div>
								);
							})}
						</div>
					</div>

					{/* Budget */}
					<div className="rounded-xl border border-border p-3">
						<div className="mb-2 flex items-center justify-between">
							<p className="font-medium text-foreground text-xs">
								Monthly budget
							</p>
							<p className="text-[11px] text-muted-foreground tabular-nums">
								$156 / $200
							</p>
						</div>
						<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
							<div className="h-full w-[78%] rounded-full bg-foreground" />
						</div>
					</div>
				</div>
			</div>
		</WindowFrame>
	);
}

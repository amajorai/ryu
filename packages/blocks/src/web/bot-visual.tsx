import { Logo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, CirclePlus, Search, Send } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "./bot-visual.module.css";

/**
 * Avatar fills paired with an initial colour that clears WCAG AA (4.5:1). The
 * chart tokens are neutral greys with the same lightness in light and dark
 * themes, so the darker steps need light initials rather than the black ink
 * the bright fills use.
 */
const AVATAR_FILLS = {
	chart1: { fill: "var(--chart-1)", ink: "text-black" },
	chart2: { fill: "var(--chart-2)", ink: "text-white" },
	chart3: { fill: "var(--chart-3)", ink: "text-white" },
	chart4: { fill: "var(--chart-4)", ink: "text-white" },
	chart5: { fill: "var(--chart-5)", ink: "text-white" },
	warning: { fill: "var(--warning)", ink: "text-black" },
} as const;

/** A compact product visual for the managed Bot workspace. */
export function BotAppVisual() {
	const bots = [
		[
			"Weekly report",
			"drafted the update from the project…",
			AVATAR_FILLS.chart2,
			"9:41",
		],
		[
			"Client follow-up",
			"reply ready for your approval…",
			AVATAR_FILLS.warning,
			"9:12",
		],
		[
			"Inbox cleanup",
			"sorted 18 messages; 5 need you…",
			AVATAR_FILLS.chart1,
			"8:30",
		],
		[
			"Meeting notes",
			"summary and owners are ready…",
			AVATAR_FILLS.chart4,
			"Tue",
		],
		[
			"Research brief",
			"pulled sources and flagged gaps…",
			AVATAR_FILLS.chart3,
			"Tue",
		],
		[
			"Expense review",
			"9 receipts matched to the report…",
			AVATAR_FILLS.chart5,
			"Mon",
		],
		[
			"Team handoff",
			"the next steps are ready to share…",
			AVATAR_FILLS.chart2,
			"Mon",
		],
	] as const;

	return (
		<div className="@container mx-auto w-full max-w-5xl overflow-hidden text-foreground/80">
			<div className="grid @3xl:min-h-[26rem] @3xl:grid-cols-[18rem_1fr]">
				<aside className="@3xl:block hidden border-border/60 border-r bg-background/60 p-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2 text-foreground/80 text-sm">
							<Logo size="22px" tone="foreground" variant="outline" />
							<span>Bot</span>
						</div>
						<CirclePlus
							aria-hidden="true"
							className="size-4 text-foreground/45"
						/>
					</div>
					<div className="mt-4 flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-foreground/40 text-xs">
						<Search aria-hidden="true" className="size-3.5" /> Search
					</div>
					<div className="mt-4 space-y-1.5">
						{bots.map(([name, preview, avatar, time], index) => (
							<div
								className={cn(
									"flex items-center gap-2.5 rounded-lg px-2 py-2",
									index === 0 && "bg-background/70"
								)}
								key={name}
							>
								<span
									className={cn(
										"flex size-8 shrink-0 items-center justify-center rounded-full text-xs",
										avatar.ink,
										styles.dynamic1
									)}
									style={
										{
											"--blocks-backgroundColor": avatar.fill,
										} satisfies PrivateStyle as PrivateStyle
									}
								>
									{name.slice(0, 1)}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-foreground/75 text-xs">
										{name}
									</span>
									<span className="type-compact block truncate text-foreground/40">
										{preview}
									</span>
								</span>
								<span className="type-compact text-foreground/30">{time}</span>
							</div>
						))}
					</div>
					<div className="mt-auto flex items-center gap-2 pt-8 text-foreground/50 text-xs">
						<span className="flex size-7 items-center justify-center rounded-full bg-background/80">
							Y
						</span>
						You
					</div>
				</aside>

				<section className="flex min-w-0 flex-col">
					<div className="flex items-center gap-2 px-5 py-4 text-foreground/80 text-sm">
						<span
							className={cn(
								"flex size-7 items-center justify-center rounded-full text-xs",
								AVATAR_FILLS.chart2.ink,
								styles.dynamic1
							)}
							style={
								{
									"--blocks-backgroundColor": AVATAR_FILLS.chart2.fill,
								} satisfies PrivateStyle as PrivateStyle
							}
						>
							W
						</span>
						Weekly report
						<ChevronDown
							aria-hidden="true"
							className="size-3.5 text-foreground/35"
						/>
					</div>
					<div className="flex flex-1 flex-col @3xl:justify-between gap-6 @3xl:p-7 p-5">
						<div>
							<div
								aria-hidden="true"
								className="max-w-sm space-y-2 rounded-2xl bg-muted px-4 py-4"
							>
								<span className="block h-1.5 w-full rounded-full bg-foreground/15" />
								<span className="block h-1.5 w-2/3 rounded-full bg-foreground/10" />
							</div>
							<span className="mt-4 inline-block rounded-full border border-border px-3 py-1 text-foreground/80 text-xs">
								Review
							</span>
						</div>
						<div
							aria-hidden="true"
							className="flex items-center gap-3 rounded-full bg-card px-4 py-3 text-foreground/40 ring-1 ring-border/60"
						>
							<span className="block h-1.5 w-1/3 rounded-full bg-foreground/10" />
							<Send className="ml-auto size-4 shrink-0" />
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}

interface PrivateStyle extends CSSProperties {
	"--blocks-backgroundColor"?: CSSProperties["backgroundColor"];
}

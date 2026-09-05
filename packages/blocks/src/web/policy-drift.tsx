import { cn } from "@ryu/ui/lib/utils";
import { Check, FileClock, Users } from "lucide-react";
import {
	LANDING_CARD_TONES,
	landingCardSurfaceClass,
	landingMutedCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";

/**
 * The trust problem startups feel but do not name: the context moves, and
 * nobody knows which version the answer used.
 */
const DRIFT = [
	{
		title: "The working rules keep changing",
		body: "Product decisions, customer commitments, and internal policies move on their own schedule.",
	},
	{
		title: "They live in different places",
		body: "An email thread, a doc, the shared drive, a project board, and someone's memory.",
	},
	{
		title: "People discover the change too late",
		body: "Your team usually finds out a rule changed only when a customer or a launch exposes the gap.",
	},
	{
		title: "Nobody can explain which version was used",
		body: "When an answer is challenged, the context behind it is scattered across the company.",
	},
] as const;

const FIXES = [
	"One current copy of how your team works",
	"Every change kept, so you can see what was true when an answer was made",
	"A correction someone makes today is what the work follows tomorrow",
	"One source for people and AI to work from",
] as const;

function VersionStack() {
	return (
		<div className="mt-6 space-y-2">
			{[
				{ label: "Current", note: "in force now", active: true },
				{ label: "Previous", note: "what last quarter ran on", active: false },
				{ label: "Before that", note: "kept, not deleted", active: false },
			].map((row) => (
				<div
					className={cn(
						"flex items-center justify-between rounded-lg px-3 py-2 text-xs",
						row.active
							? "bg-foreground/10 text-foreground"
							: "bg-foreground/5 text-foreground/50"
					)}
					key={row.label}
				>
					<span className="font-medium">{row.label}</span>
					<span>{row.note}</span>
				</div>
			))}
		</div>
	);
}

export default function PolicyDrift() {
	const tone = LANDING_CARD_TONES.blue;

	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<StaggerLines className="max-w-2xl">
					<SectionTitle title="Your team's context is spread across too many places." />
					<p className={sectionSubtitleClass}>
						The files, rules, and decisions behind an answer are often in
						different tools.
					</p>
				</StaggerLines>

				<div className="mt-14 grid gap-6 md:grid-cols-2">
					<Reveal>
						<div className={landingMutedCardSurfaceClass}>
							<FileClock
								aria-hidden="true"
								className="size-5 text-foreground"
								strokeWidth={1.75}
							/>
							<p className="mt-6 font-medium text-muted-foreground/60 text-xs uppercase tracking-widest">
								Everyday reality
							</p>
							<h3 className="mt-2 font-medium text-foreground text-xl tracking-tight md:text-2xl">
								Nobody holds the whole picture
							</h3>
							<ul className="mt-6 space-y-4">
								{DRIFT.map((item) => (
									<li key={item.title}>
										<p className="font-medium text-foreground/90 text-sm">
											{item.title}
										</p>
										<p className="mt-0.5 text-muted-foreground text-sm leading-relaxed">
											{item.body}
										</p>
									</li>
								))}
							</ul>
						</div>
					</Reveal>

					<Reveal delay={0.08}>
						<div className={landingCardSurfaceClass("blue")}>
							<Users
								aria-hidden="true"
								className={cn("size-5", tone.title)}
								strokeWidth={1.75}
							/>
							<p
								className={cn(
									"mt-6 font-medium text-xs uppercase tracking-widest",
									tone.eyebrow
								)}
							>
								With Ryu
							</p>
							<h3
								className={cn(
									"mt-2 font-medium text-xl tracking-tight md:text-2xl",
									tone.title
								)}
							>
								One current source for every answer
							</h3>
							<ul className="mt-6 space-y-3">
								{FIXES.map((fix) => (
									<li className="flex items-start gap-3" key={fix}>
										<Check
											aria-hidden="true"
											className={cn("mt-0.5 size-4 shrink-0", tone.marker)}
											strokeWidth={1.5}
										/>
										<span
											className={cn("text-sm leading-relaxed", tone.bullet)}
										>
											{fix}
										</span>
									</li>
								))}
							</ul>
							<VersionStack />
						</div>
					</Reveal>
				</div>

				<p className="mt-10 max-w-2xl text-muted-foreground text-sm leading-relaxed md:text-base">
					Every correction your team makes is kept, so the answers become more
					consistent the longer you use them.
				</p>
			</div>
		</section>
	);
}

import { cn } from "@ryu/ui/lib/utils";
import { AlertTriangle, BadgeCheck, Check, ShieldCheck, X } from "lucide-react";
import {
	LANDING_CARD_TONES,
	landingCardSurfaceClass,
	landingMutedCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";

/**
 * Keep the contrast plain. A startup does not need a control-plane lecture; it
 * needs to know what the AI saw, what it changed, what it cost, and where a
 * person can stop it.
 */

const RISKS = [
	"No record of what AI saw or changed",
	"Company data gets sent somewhere no one approved",
	"No spending ceiling, so nobody can promise what next month costs",
	"Someone has to babysit every workflow to keep it usable",
] as const;

const DEFENSES = [
	"Inputs, outputs, and decisions written down clearly",
	"Access limited to the files and systems you choose",
	"A spending ceiling enforced while the work runs",
	"Anything sensitive pauses for a person to say yes",
] as const;

function RiskCard() {
	return (
		<div className={landingMutedCardSurfaceClass}>
			<AlertTriangle className="size-5 text-foreground" strokeWidth={1.75} />
			<p className="mt-6 font-medium text-muted-foreground/60 text-xs uppercase tracking-widest">
				Why it never ships
			</p>
			<h3 className="mt-2 font-medium text-foreground text-xl tracking-tight md:text-2xl">
				It looks useful, and still nobody will ship it
			</h3>
			<ul className="mt-6 space-y-3">
				{RISKS.map((risk) => (
					<li className="flex items-start gap-3" key={risk}>
						<X
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-muted-foreground/70"
							strokeWidth={1.5}
						/>
						<span className="text-foreground/80 text-sm leading-relaxed">
							{risk}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function DefenseCard() {
	const tone = LANDING_CARD_TONES.green;
	return (
		<div className={landingCardSurfaceClass("green")}>
			<ShieldCheck className={cn("size-5", tone.title)} strokeWidth={1.75} />
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
				Your team can stand behind the result
			</h3>
			<ul className="mt-6 space-y-3">
				{DEFENSES.map((defense) => (
					<li className="flex items-start gap-3" key={defense}>
						<Check
							aria-hidden="true"
							className={cn("mt-0.5 size-4 shrink-0", tone.marker)}
							strokeWidth={1.5}
						/>
						<span className={cn("text-sm leading-relaxed", tone.bullet)}>
							{defense}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export default function SecureByDefault() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<StaggerLines className="max-w-2xl">
					<SectionTitle title="Your team needs to see what happened." />
					<p className={sectionSubtitleClass}>
						Ryu shows what the AI used, produced, changed, and cost before
						important work moves on.
					</p>
				</StaggerLines>

				<div className="mt-14 grid gap-6 md:grid-cols-2">
					<Reveal>
						<RiskCard />
					</Reveal>
					<Reveal delay={0.08}>
						<DefenseCard />
					</Reveal>
				</div>

				<p className="mt-10 flex max-w-xl items-center gap-2 font-medium text-muted-foreground text-sm md:text-base">
					<BadgeCheck
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.5}
					/>
					Every important AI task leaves a record your team can stand behind.
				</p>
			</div>
		</section>
	);
}

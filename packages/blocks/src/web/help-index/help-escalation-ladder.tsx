import { cn } from "@ryu/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { landingSectionClass } from "../landing-typography.ts";
import { LinkArrow } from "../link-arrow.tsx";
import {
	sectionBodyClass,
	sectionItemTitleClass,
} from "../product-page/sections/section-shell.tsx";
import { sectionTitleClass } from "../section-title.tsx";
import {
	HELP_ESCALATION_SECTION,
	HELP_ESCALATION_STEPS,
	type HelpEscalationStep,
} from "./help-index-content.ts";

// The /help escalation ladder: an ordered track from the docs to the team.
// The ordered list carries the sequence for assistive tech; the step numbers
// and the rule between them are decoration. Server-safe (no hooks).

const stepLinkClass =
	"group inline-flex min-h-10 w-fit items-center gap-1.5 font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function StepLink({ step }: { step: HelpEscalationStep }) {
	const label = (
		<>
			{step.linkLabel}
			<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
		</>
	);
	if (step.plainAnchor) {
		return (
			<a className={stepLinkClass} href={step.href}>
				{label}
			</a>
		);
	}
	return (
		<Link
			className={stepLinkClass}
			/* SAFETY: COMPANY_ROUTES paths, pinned by help-index.test.tsx. */
			href={step.href as Route}
		>
			{label}
		</Link>
	);
}

export function HelpEscalationLadder({
	steps = HELP_ESCALATION_STEPS,
	className,
}: {
	steps?: readonly HelpEscalationStep[];
	className?: string;
}) {
	if (steps.length === 0) {
		return null;
	}
	const headingId = `${HELP_ESCALATION_SECTION.id}-heading`;
	return (
		<section
			aria-labelledby={headingId}
			className={cn(landingSectionClass, className)}
			data-testid="help-escalation"
		>
			<header className="mb-10 max-w-2xl md:mb-12">
				<h2 className={sectionTitleClass} id={headingId}>
					{HELP_ESCALATION_SECTION.title}
				</h2>
				<p className={cn(sectionBodyClass, "mt-4 max-w-xl")}>
					{HELP_ESCALATION_SECTION.subtitle}
				</p>
			</header>
			<ol className="grid gap-10 md:grid-cols-4 md:gap-8">
				{steps.map((step, index) => (
					<li
						className="relative flex flex-col gap-3 ps-12 md:ps-0 md:pt-14"
						data-help-step={step.id}
						key={step.id}
					>
						<span
							aria-hidden="true"
							className="absolute start-0 top-0 flex size-8 items-center justify-center rounded-full bg-foreground font-mono text-background text-xs"
						>
							{index + 1}
						</span>
						{index < steps.length - 1 ? (
							<span
								aria-hidden="true"
								className="absolute start-4 top-10 bottom-[-2rem] w-px bg-border md:start-10 md:end-[-2rem] md:top-4 md:bottom-auto md:h-px md:w-auto"
							/>
						) : null}
						<h3 className={sectionItemTitleClass}>{step.title}</h3>
						<p className={cn(sectionBodyClass, "md:text-sm")}>{step.purpose}</p>
						<StepLink step={step} />
					</li>
				))}
			</ol>
		</section>
	);
}

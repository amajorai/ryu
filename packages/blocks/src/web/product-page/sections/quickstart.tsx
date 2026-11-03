import { cn } from "@ryu/ui/lib/utils";
import { SectionTitle } from "../../section-title.tsx";
import type { ProductQuickstartStep } from "../profile-types.ts";
import { CopyButton } from "./copy-button.tsx";
import {
	ProductSection,
	sectionBodyClass,
	sectionItemTitleClass,
	sectionKickerClass,
} from "./section-shell.tsx";

/** A command line with its own copy button; the prompt glyph is decoration. */
function CommandLine({ command }: { command: string }) {
	return (
		<div className="mt-4 flex min-w-0 items-start gap-3 rounded-xl bg-muted/60 py-2 ps-4 pe-2">
			<code
				className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md py-1.5 font-mono text-foreground text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a long command scrolls sideways inside its line, so keyboard users focus it to scroll (WCAG 2.1.1).
				tabIndex={0}
			>
				<span aria-hidden="true" className="select-none text-muted-foreground">
					${" "}
				</span>
				{command}
			</code>
			<CopyButton text={command} />
		</div>
	);
}

/**
 * A numbered quickstart: the heading holds still on the left from lg up while
 * the steps run down a vertical rule on the right, each command copyable.
 */
export function ProductQuickstart({
	steps,
	title = "Get started",
	subtitle,
}: {
	steps: readonly ProductQuickstartStep[];
	title?: string;
	subtitle?: string;
}) {
	if (steps.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-quickstart">
			<div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-16">
				<header className="lg:sticky lg:top-36 lg:self-start">
					<p className={cn(sectionKickerClass, "mb-4")}>Quickstart</p>
					<SectionTitle title={title} />
					{subtitle ? (
						<p className={cn(sectionBodyClass, "mt-4 max-w-md")}>{subtitle}</p>
					) : null}
				</header>
				<ol className="min-w-0">
					{steps.map((step, index) => (
						<li
							className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-5 pb-10 after:absolute after:start-4 after:top-10 after:bottom-2 after:w-px after:bg-border last:pb-0 last:after:hidden"
							key={step.title}
						>
							<span
								aria-hidden="true"
								className="flex size-8 items-center justify-center rounded-full bg-foreground font-mono text-background text-xs tabular-nums"
							>
								{index + 1}
							</span>
							<div className="min-w-0 pt-1">
								<h3 className={sectionItemTitleClass}>{step.title}</h3>
								<p className={cn(sectionBodyClass, "mt-2")}>
									{step.description}
								</p>
								{step.command ? <CommandLine command={step.command} /> : null}
							</div>
						</li>
					))}
				</ol>
			</div>
		</ProductSection>
	);
}

import { cn } from "@ryu/ui/lib/utils";
import { SectionTitle } from "../../section-title.tsx";
import type {
	ProductGuardrailDemo as GuardrailDemo,
	ProductTerminalLine,
	ProductTerminalLineKind,
} from "../profile-types.ts";
import {
	ProductSection,
	sectionBodyClass,
	sectionKickerClass,
} from "./section-shell.tsx";

/** Verdict lines carry a word as well as a colour, so the result never rests on colour alone. */
const VERDICTS: Partial<
	Record<ProductTerminalLineKind, { label: string; className: string }>
> = {
	allowed: {
		label: "Allowed",
		className: "bg-success/15 text-success",
	},
	denied: {
		label: "Denied",
		className: "bg-destructive/15 text-destructive",
	},
};

function TerminalLine({ line }: { line: ProductTerminalLine }) {
	const verdict = VERDICTS[line.kind];
	return (
		<span
			className="flex min-w-0 items-start gap-3"
			data-terminal-line={line.kind}
		>
			{line.kind === "command" ? (
				<span aria-hidden="true" className="select-none text-muted-foreground">
					$
				</span>
			) : null}
			{verdict ? (
				<span
					className={cn(
						"shrink-0 rounded px-1.5 font-medium text-xs leading-6",
						verdict.className
					)}
				>
					{verdict.label}
				</span>
			) : null}
			<span
				className={cn(
					"min-w-0 whitespace-pre-wrap break-words",
					line.kind === "output" ? "text-muted-foreground" : "text-foreground"
				)}
			>
				{line.text}
			</span>
		</span>
	);
}

/**
 * A control saying no, shown as a terminal transcript beside its explanation.
 * Meant to sit in an inverse band, so the transcript reads as a real session.
 */
export function ProductGuardrailDemo({ demo }: { demo: GuardrailDemo }) {
	if (demo.lines.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-guardrail">
			<div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
				<header className="min-w-0">
					<p className={cn(sectionKickerClass, "mb-4")}>Guardrails</p>
					<SectionTitle title={demo.title} />
					<p className={cn(sectionBodyClass, "mt-4 max-w-md")}>
						{demo.description}
					</p>
				</header>
				<figure className="min-w-0 overflow-hidden rounded-2xl border border-border bg-background">
					<figcaption className="flex items-center gap-2 border-border border-b px-4 py-3">
						<span aria-hidden="true" className="flex gap-1.5">
							<span className="size-2.5 rounded-full bg-muted" />
							<span className="size-2.5 rounded-full bg-muted" />
							<span className="size-2.5 rounded-full bg-muted" />
						</span>
						<span className="ms-2 font-mono text-muted-foreground text-xs">
							Terminal
						</span>
					</figcaption>
					<pre className="grid gap-2 overflow-x-auto p-5 font-mono text-sm leading-6">
						{demo.lines.map((line, index) => (
							// Lines are positional: a transcript can repeat a line.
							<TerminalLine key={index} line={line} />
						))}
					</pre>
				</figure>
			</div>
		</ProductSection>
	);
}

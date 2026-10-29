/** One step of a numbered "how it works" list. */
export interface NumberedStep {
	description: string;
	title: string;
}

/** A calm, ruled numbered list for "how it works" sections on hub pages. */
export function StepList({
	steps,
	className,
}: {
	steps: readonly NumberedStep[];
	className?: string;
}) {
	return (
		<ol className={className}>
			{steps.map((step, index) => (
				<li
					className="grid grid-cols-[1.25rem_1fr] gap-x-4 gap-y-1 py-4 md:py-5"
					key={step.title}
				>
					<span className="text-muted-foreground text-sm tabular-nums">
						{index + 1}
					</span>
					<span>
						<span className="block font-heading font-medium text-base text-foreground">
							{step.title}
						</span>
						<span className="mt-1 block text-muted-foreground text-sm leading-relaxed">
							{step.description}
						</span>
					</span>
				</li>
			))}
		</ol>
	);
}

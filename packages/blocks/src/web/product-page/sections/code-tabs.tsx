"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ProductCodeLanguage } from "../profile-types.ts";
import { CopyButton } from "./copy-button.tsx";
import { tabIds } from "./tab-keys.ts";
import { useRovingTabs } from "./use-roving-tabs.ts";

export interface CodeTab {
	readonly code: string;
	readonly filename?: string;
	readonly id: string;
	readonly label: string;
	readonly language: ProductCodeLanguage;
}

/** Focus ring for a scrollable sample frame (inset, so the frame does not clip it). */
const SAMPLE_FOCUS_CLASS =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const COMMENT_LINE = /^\s*(?:#|\/\/)/;

/** Numbered lines; comment lines step back so the code reads first. */
function CodeLines({ code }: { code: string }) {
	const lines = code.replace(/\n$/, "").split("\n");
	return (
		<pre className="overflow-x-auto px-5 py-5 font-mono text-sm leading-relaxed">
			<code className="grid min-w-max">
				{lines.map((line, index) => (
					<span
						className="grid grid-cols-[2rem_1fr] gap-4"
						// Lines are positional: the same text can repeat in one sample.
						key={index}
					>
						<span
							aria-hidden="true"
							className="select-none text-end text-muted-foreground tabular-nums"
						>
							{index + 1}
						</span>
						<span
							className={cn(
								"whitespace-pre",
								COMMENT_LINE.test(line)
									? "text-muted-foreground"
									: "text-foreground"
							)}
						>
							{line || " "}
						</span>
					</span>
				))}
			</code>
		</pre>
	);
}

/**
 * One code frame with a tab per sample. Every panel is in the server HTML;
 * inactive panels carry `hidden`, so crawlers and tests see all samples. A
 * single sample renders without a tab list. The copy button copies the
 * selected sample.
 */
export function CodeTabs({
	groupId,
	samples,
	label = "Code samples",
	className,
}: {
	groupId: string;
	samples: readonly CodeTab[];
	/** Accessible name of the tab list. */
	label?: string;
	className?: string;
}) {
	const { selected, setSelected, onKeyDown, registerTab } = useRovingTabs(
		samples.length,
		"horizontal"
	);
	const tabListLabel = useLocalizedText(label, { literal: true });
	const active = samples[selected] ?? samples[0];
	if (!active) {
		return null;
	}
	const tabbed = samples.length > 1;

	return (
		<figure
			className={cn(
				"min-w-0 overflow-hidden rounded-2xl border border-border bg-background text-foreground",
				className
			)}
			data-product-code-frame=""
		>
			<header className="flex min-w-0 items-center gap-3 border-border border-b py-2 ps-3 pe-2">
				{tabbed ? (
					<div
						aria-label={typeof tabListLabel === "string" ? tabListLabel : label}
						className="-my-2 flex min-w-0 gap-1 overflow-x-auto py-2"
						onKeyDown={onKeyDown}
						role="tablist"
					>
						{samples.map((sample, index) => {
							const ids = tabIds(groupId, sample.id);
							const isSelected = index === selected;
							return (
								<button
									aria-controls={ids.panel}
									aria-selected={isSelected}
									className={cn(
										"min-h-8 shrink-0 rounded-full px-3 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										isSelected
											? "bg-foreground text-background"
											: "text-muted-foreground hover:text-foreground"
									)}
									id={ids.tab}
									key={sample.id}
									onClick={() => setSelected(index)}
									ref={registerTab(index)}
									role="tab"
									tabIndex={isSelected ? 0 : -1}
									type="button"
								>
									{sample.label}
								</button>
							);
						})}
					</div>
				) : (
					<span className="truncate font-medium text-foreground text-xs">
						{active.label}
					</span>
				)}
				<span className="ms-auto hidden truncate font-mono text-muted-foreground text-xs sm:inline">
					{active.filename ?? active.language}
				</span>
				<CopyButton text={active.code} />
			</header>
			{samples.map((sample, index) => {
				const ids = tabIds(groupId, sample.id);
				return tabbed ? (
					<div
						aria-labelledby={ids.tab}
						className={SAMPLE_FOCUS_CLASS}
						data-code-sample={sample.id}
						hidden={index !== selected}
						id={ids.panel}
						key={sample.id}
						role="tabpanel"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the panel scrolls sideways and holds no focusable element, so keyboard users focus it to scroll (WAI-ARIA tabs pattern).
						tabIndex={0}
					>
						<CodeLines code={sample.code} />
					</div>
				) : (
					<div
						aria-label={sample.filename ?? sample.label}
						className={SAMPLE_FOCUS_CLASS}
						data-code-sample={sample.id}
						key={sample.id}
						role="region"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: the sample scrolls sideways and holds no focusable element, so keyboard users focus it to scroll (WCAG 2.1.1).
						tabIndex={0}
					>
						<CodeLines code={sample.code} />
					</div>
				);
			})}
		</figure>
	);
}

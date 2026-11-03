import type { ProductArchitecture } from "../profile-types.ts";
import {
	ProductSection,
	ProductSectionHeader,
	sectionItemTitleClass,
} from "./section-shell.tsx";

/**
 * A request or data flow as numbered nodes: a row joined by hairline
 * connectors from lg up, a column joined by a vertical rule below it. The
 * connectors are pseudo-elements, so the list stays a plain ordered list.
 */
export function ProductArchitectureFlow({
	architecture,
}: {
	architecture: ProductArchitecture;
}) {
	const { caption, nodes, title } = architecture;
	if (nodes.length === 0) {
		return null;
	}
	return (
		<ProductSection testId="product-architecture">
			<ProductSectionHeader
				kicker="Architecture"
				subtitle={caption}
				title={title}
			/>
			<ol
				className="grid gap-4 lg:auto-cols-fr lg:grid-flow-col lg:gap-6"
				data-node-count={nodes.length}
			>
				{nodes.map((node, index) => (
					<li
						className="relative flex min-w-0 flex-col gap-3 rounded-2xl bg-muted/50 p-5 after:absolute after:start-8 after:top-full after:h-4 after:w-px after:bg-border last:after:hidden lg:after:start-full lg:after:top-1/2 lg:after:h-px lg:after:w-6"
						data-product-card=""
						key={node.label}
					>
						<span
							aria-hidden="true"
							className="flex size-7 items-center justify-center rounded-full bg-background font-mono text-muted-foreground text-xs tabular-nums"
						>
							{index + 1}
						</span>
						<h3 className={sectionItemTitleClass}>{node.label}</h3>
						<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
							{node.detail}
						</p>
					</li>
				))}
			</ol>
		</ProductSection>
	);
}

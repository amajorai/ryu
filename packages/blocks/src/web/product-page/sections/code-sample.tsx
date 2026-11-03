import { cn } from "@ryu/ui/lib/utils";
import type { ProductCodeSample } from "../profile-types.ts";
import { CodeTabs } from "./code-tabs.tsx";
import {
	ProductSection,
	ProductSectionHeader,
	sectionBodyClass,
	sectionKickerClass,
} from "./section-shell.tsx";

export type ProductCodeLayout = "lead" | "stacked" | "column";

/**
 * Real code from the docs or source. Three layouts:
 * - `lead` (builder pages open on it): a wide frame under a one-line header;
 * - `stacked`: header above the frame, the default;
 * - `column`: a compact header for a half-width band (beside "Ways to call it").
 */
export function ProductCodeSamples({
	samples,
	groupId,
	title = "Start from real code",
	subtitle,
	layout = "stacked",
}: {
	samples: readonly ProductCodeSample[];
	groupId: string;
	title?: string;
	subtitle?: string;
	layout?: ProductCodeLayout;
}) {
	if (samples.length === 0) {
		return null;
	}
	const tabs = samples.map(({ code, filename, id, label, language }) => ({
		code,
		filename,
		id,
		label,
		language,
	}));

	if (layout === "column") {
		return (
			<ProductSection testId="product-code">
				<h2 className={cn(sectionKickerClass, "mb-4")}>Code</h2>
				<p className={cn(sectionBodyClass, "mb-6 max-w-md")}>
					{subtitle ?? title}
				</p>
				<CodeTabs groupId={groupId} samples={tabs} />
			</ProductSection>
		);
	}

	return (
		<ProductSection testId="product-code">
			<ProductSectionHeader
				kicker={layout === "lead" ? "Code" : undefined}
				size={layout === "lead" ? "small" : "default"}
				subtitle={subtitle}
				title={title}
			/>
			<CodeTabs groupId={groupId} samples={tabs} />
		</ProductSection>
	);
}

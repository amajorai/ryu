import type { ReactNode } from "react";
import { ARCHETYPE_SIDE_BY_SIDE } from "../archetypes.ts";
import { productDocsPath } from "../product-docs-path.ts";
import type { ProductSectionKey } from "../profile-types.ts";
import { ProductApiPanel } from "../sections/api-panel.tsx";
import { ProductAvailabilityMatrix } from "../sections/availability-matrix.tsx";
import { ProductCatalogGrid } from "../sections/catalog-grid.tsx";
import {
	type ProductCodeLayout,
	ProductCodeSamples,
} from "../sections/code-sample.tsx";
import { ProductCompareLinks } from "../sections/compare-links.tsx";
import { ProductComparisonTable } from "../sections/comparison-table.tsx";
import { ProductDocsLinks } from "../sections/docs-links.tsx";
import { ProductGuardrailDemo } from "../sections/guardrail-demo.tsx";
import { ProductInterfaceTable } from "../sections/interface-table.tsx";
import { ProductLimitsTable } from "../sections/limits-table.tsx";
import { ProductArchitectureFlow } from "../sections/product-architecture.tsx";
import { ProductQuickstart } from "../sections/quickstart.tsx";
import { ProductRelatedLinks } from "../sections/related-links.tsx";
import { ProductSecurityPanel } from "../sections/security-panel.tsx";
import { ProductStatusBoard } from "../sections/status-board.tsx";
import type { SlotContext } from "./section-slots.tsx";

/** The profile-driven keys, filled here so section-slots.tsx stays readable. */
export type ProfileSlotKey = Extract<
	ProductSectionKey,
	| "architecture"
	| "code"
	| "interfaces"
	| "api"
	| "limits"
	| "quickstart"
	| "comparison"
	| "guardrail"
	| "security"
	| "availability"
	| "catalog"
	| "status-board"
	| "compare"
	| "related"
	| "docs"
>;

/** True when both halves of the archetype's side-by-side pair have content. */
function pairsCodeWithInterfaces(context: SlotContext): boolean {
	const pair = ARCHETYPE_SIDE_BY_SIDE[context.archetype];
	const { profile } = context;
	return Boolean(
		pair?.includes("code") &&
			pair.includes("interfaces") &&
			profile?.code?.length &&
			profile.interfaces?.length
	);
}

/**
 * "column" only makes sense inside the side-by-side band; an archetype whose
 * pair did not form falls back to the stacked frame.
 */
export function codeLayoutFor(
	paired: boolean,
	layout: ProductCodeLayout
): ProductCodeLayout {
	if (paired) {
		return "column";
	}
	return layout === "column" ? "stacked" : layout;
}

/**
 * Slots built from the product's profile. A missing profile (or a missing
 * field) leaves the slot null, so a page without a profile still renders its
 * authored content in its archetype's order. The security panel is built for
 * every infrastructure page (links only, if the profile has no points) and for
 * any profile with points; only the infrastructure order places it.
 */
export function profileSlots(
	context: SlotContext
): Record<ProfileSlotKey, ReactNode | null> {
	const { archetype, compareNames, product, profile, theme } = context;
	const paired = pairsCodeWithInterfaces(context);
	const code = profile?.code ?? [];
	const interfaces = profile?.interfaces ?? [];
	const docsPath = productDocsPath(product);
	const showSecurity =
		Boolean(profile?.security?.points.length) || archetype === "infrastructure";

	return {
		architecture: profile?.architecture ? (
			<ProductArchitectureFlow architecture={profile.architecture} />
		) : null,
		code: code.length ? (
			<ProductCodeSamples
				groupId={`${product.slug}-code`}
				layout={codeLayoutFor(paired, theme.codeLayout)}
				samples={code}
				subtitle={paired ? "Call it from your own code." : undefined}
			/>
		) : null,
		interfaces: interfaces.length ? (
			<ProductInterfaceTable compact={paired} rows={interfaces} />
		) : null,
		api: profile?.openapi ? (
			<ProductApiPanel docsPath={docsPath} openapi={profile.openapi} />
		) : null,
		limits: profile?.limits?.rows.length ? (
			<ProductLimitsTable limits={profile.limits} />
		) : null,
		quickstart: profile?.quickstart?.length ? (
			<ProductQuickstart steps={profile.quickstart} />
		) : null,
		comparison: profile?.comparison?.rows.length ? (
			<ProductComparisonTable comparison={profile.comparison} />
		) : null,
		guardrail: profile?.guardrail?.lines.length ? (
			<ProductGuardrailDemo demo={profile.guardrail} />
		) : null,
		security: showSecurity ? (
			<ProductSecurityPanel security={profile?.security} />
		) : null,
		availability: profile?.availability?.length ? (
			<ProductAvailabilityMatrix
				rows={profile.availability}
				title={profile.availabilityTitle}
			/>
		) : null,
		catalog: profile?.catalog?.items.length ? (
			<ProductCatalogGrid catalog={profile.catalog} />
		) : null,
		"status-board":
			profile?.status &&
			profile.status.today.length +
				profile.status.planned.length +
				(profile.status.notPlanned?.length ?? 0) >
				0 ? (
				<ProductStatusBoard status={profile.status} />
			) : null,
		compare: profile?.compareSlugs?.length ? (
			<ProductCompareLinks names={compareNames} slugs={profile.compareSlugs} />
		) : null,
		related: profile?.related?.length ? (
			<ProductRelatedLinks links={profile.related} />
		) : null,
		docs: profile?.docs?.length ? (
			<ProductDocsLinks links={profile.docs} />
		) : null,
	};
}

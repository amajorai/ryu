import { cn } from "@ryu/ui/lib/utils";
import { landingSectionClass } from "../landing-typography.ts";
import { FactSheet } from "../page-sections/fact-sheet.tsx";
import { SECTION_ANCHOR_CLASS } from "../product-page/sections/section-nav.tsx";
import {
	sectionBodyClass,
	sectionKickerClass,
} from "../product-page/sections/section-shell.tsx";
import { ENTERPRISE_FACTS } from "./enterprise-data.ts";

/** The fact rows without their sources, ready for `FactSheet`. */
export function enterpriseFactRows() {
	return ENTERPRISE_FACTS.map(({ external, href, label, value }) => ({
		external,
		href,
		label,
		value,
	}));
}

/**
 * The plan in one sheet: what Enterprise is (from the plans docs) beside the
 * terms, identity standards and deployment choices, as ruled label/value rows.
 */
export function EnterpriseGlance() {
	return (
		<section
			aria-labelledby="at-a-glance-title"
			className={cn(landingSectionClass, SECTION_ANCHOR_CLASS)}
			data-testid="enterprise-at-a-glance"
			id="at-a-glance"
		>
			<div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
				<div className="flex flex-col gap-4">
					<p className={sectionKickerClass}>At a glance</p>
					<h2
						className="text-balance font-heading font-medium text-2xl text-foreground leading-tight tracking-tight md:text-3xl"
						id="at-a-glance-title"
					>
						A contract shaped around your organization
					</h2>
					<p className={cn(sectionBodyClass, "max-w-sm")}>
						For organizations that need more capacity, dedicated or self-hosted
						deployment, SSO and SCIM, or their own procurement terms.
					</p>
				</div>
				<FactSheet
					columns={2}
					facts={enterpriseFactRows()}
					testId="enterprise-facts"
				/>
			</div>
		</section>
	);
}

import { cn } from "@ryu/ui/lib/utils";
import { landingSectionClass } from "../landing-typography.ts";
import { CodeTabs } from "../product-page/sections/code-tabs.tsx";
import { SECTION_ANCHOR_CLASS } from "../product-page/sections/section-nav.tsx";
import {
	ProductSectionHeader,
	sectionBodyClass,
	sectionItemTitleClass,
	sectionKickerClass,
} from "../product-page/sections/section-shell.tsx";
import { IDENTITY_ENDPOINTS, ROLLOUT_STEPS } from "./enterprise-data.ts";

const ENDPOINT_TABS = IDENTITY_ENDPOINTS.map(
	({ code, id, label, language }) => ({
		code,
		id,
		label,
		language,
	})
);

/**
 * The docs' safe-rollout checklist as a numbered sequence on one rule (five
 * across from lg), then the two URLs a directory administrator copies into
 * the identity provider, in a wide code frame so neither is cut off.
 */
export function EnterpriseRollout() {
	return (
		<section
			className={cn(landingSectionClass, SECTION_ANCHOR_CLASS)}
			data-testid="enterprise-rollout"
			id="rollout"
		>
			<ProductSectionHeader
				kicker="Rollout"
				subtitle="The checklist from the identity docs, in the order to run it."
				title="Roll out in stages"
			/>
			<ol className="grid sm:grid-cols-2 lg:grid-cols-5">
				{ROLLOUT_STEPS.map((step, index) => (
					<li
						className="relative flex flex-col gap-2 border-border border-t pe-6 pt-6 pb-8"
						key={step.title}
					>
						<span
							aria-hidden="true"
							className="absolute start-0 top-0 size-2.5 -translate-y-1/2 rounded-full bg-foreground"
						/>
						<span
							aria-hidden="true"
							className="font-mono text-muted-foreground text-sm tabular-nums"
						>
							{String(index + 1).padStart(2, "0")}
						</span>
						<h3 className={sectionItemTitleClass}>{step.title}</h3>
						<p className={sectionBodyClass}>{step.description}</p>
					</li>
				))}
			</ol>
			<div
				className="mt-8 grid gap-6 lg:mt-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-start lg:gap-16"
				data-testid="enterprise-endpoints"
			>
				<div className="flex flex-col gap-1.5">
					<p className={sectionKickerClass}>
						What your identity provider needs
					</p>
					<p className="text-pretty text-muted-foreground text-sm leading-relaxed">
						The SAML assertion consumer URL and the SCIM 2.0 base URL. Replace
						the placeholders with your Ryu auth host and provider ID.
					</p>
				</div>
				<CodeTabs
					groupId="enterprise-endpoints"
					label="Identity provider URLs"
					samples={ENDPOINT_TABS}
				/>
			</div>
		</section>
	);
}

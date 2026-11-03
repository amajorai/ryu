import { cn } from "@ryu/ui/lib/utils";
import {
	Info,
	KeyRound,
	LifeBuoy,
	type LucideIcon,
	ShieldCheck,
} from "lucide-react";
import { docsHref } from "../data/resources.tsx";
import { landingSectionClass } from "../landing-typography.ts";
import { LinkArrow } from "../link-arrow.tsx";
import { SECTION_ANCHOR_CLASS } from "../product-page/sections/section-nav.tsx";
import {
	sectionBodyClass,
	sectionChipClass,
	sectionItemTitleClass,
	sectionKickerClass,
	sectionSurfaceClass,
} from "../product-page/sections/section-shell.tsx";
import {
	ENTERPRISE_GATED_NOTE,
	type EnterpriseGroup,
	type EnterpriseGroupId,
	type EnterpriseItem,
} from "./enterprise-groups-data.ts";

const GROUP_ICONS: Readonly<Record<EnterpriseGroupId, LucideIcon>> = {
	governance: KeyRound,
	security: ShieldCheck,
	support: LifeBuoy,
};

/** "rows": ruled two-column list. "cards": tinted tiles plus the gating note. */
export type EnterpriseGroupLayout = "rows" | "cards";

/** The tag text for controls the docs gate on an Enterprise entitlement. */
export const ENTERPRISE_TAG = "Enterprise";

function ItemHeading({ item }: { item: EnterpriseItem }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<h3 className={sectionItemTitleClass}>{item.title}</h3>
			{item.enterprise ? (
				<span className={sectionChipClass} data-enterprise-tag="">
					{ENTERPRISE_TAG}
				</span>
			) : null}
		</div>
	);
}

function GroupItems({
	items,
	layout,
}: {
	items: readonly EnterpriseItem[];
	layout: EnterpriseGroupLayout;
}) {
	if (layout === "cards") {
		return (
			<ul className="grid gap-4 sm:grid-cols-2">
				{items.map((item) => (
					<li
						className={cn(sectionSurfaceClass, "flex flex-col gap-3 p-6")}
						data-product-card=""
						key={item.title}
					>
						<ItemHeading item={item} />
						<p className={sectionBodyClass}>{item.description}</p>
					</li>
				))}
			</ul>
		);
	}
	return (
		<ul className="grid border-border border-t sm:grid-cols-2 sm:gap-x-10">
			{items.map((item) => (
				<li
					className="flex flex-col gap-2 border-border border-b py-6"
					key={item.title}
				>
					<ItemHeading item={item} />
					<p className={sectionBodyClass}>{item.description}</p>
				</li>
			))}
		</ul>
	);
}

/**
 * One themed group (Governance, Security or Support): a sticky intro column
 * with the group's docs link beside its controls. Items carry an "Enterprise"
 * tag only where the docs gate them on an Enterprise entitlement.
 */
export function EnterpriseGroupSection({
	group,
	layout = "rows",
}: {
	group: EnterpriseGroup;
	layout?: EnterpriseGroupLayout;
}) {
	const Icon = GROUP_ICONS[group.id];
	const titleId = `${group.id}-title`;
	return (
		<section
			aria-labelledby={titleId}
			className={cn(landingSectionClass, SECTION_ANCHOR_CLASS)}
			data-enterprise-group={group.id}
			data-enterprise-layout={layout}
			data-testid={`enterprise-group-${group.id}`}
			id={group.id}
		>
			<div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
				<header className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
					<p className={cn(sectionKickerClass, "flex items-center gap-2")}>
						<span
							aria-hidden="true"
							className="flex size-8 items-center justify-center rounded-lg bg-muted text-foreground"
						>
							<Icon className="size-4" />
						</span>
						{group.kicker}
					</p>
					<h2
						className="text-balance font-heading font-medium text-2xl text-foreground leading-tight tracking-tight md:text-3xl"
						id={titleId}
					>
						{group.title}
					</h2>
					<p className={cn(sectionBodyClass, "max-w-md")}>{group.summary}</p>
					<a
						className="group inline-flex min-h-10 items-center gap-1.5 self-start font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						href={docsHref(group.docs.path)}
						rel="noopener noreferrer"
						target="_blank"
					>
						{group.docs.label}
						<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
					</a>
				</header>
				<div className="flex min-w-0 flex-col gap-6">
					<GroupItems items={group.items} layout={layout} />
					{layout === "cards" ? (
						<p
							className="flex gap-3 text-pretty text-muted-foreground text-sm leading-relaxed"
							data-testid="enterprise-gated-note"
						>
							<Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
							{ENTERPRISE_GATED_NOTE.text}
						</p>
					) : null}
				</div>
			</div>
		</section>
	);
}

"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import {
	MotionNavigationMenuContent,
	MotionNavigationMenuLink,
	MotionNavigationMenuTrigger,
} from "@ryu/ui/components/motion-navigation-menu";
import Link from "next/link";
import { createContext, type ReactElement, use } from "react";
import {
	type ProductNavGroup,
	productMenuGroupsFor,
} from "./data/product-realms.ts";
import {
	PLAN_LINKS,
	type Resource,
	resourceCategories,
	resourcesByCategory,
} from "./data/resources.tsx";
import {
	isWithinPrefixes,
	PRODUCT_ACTIVE_PREFIXES,
	RESOURCE_ACTIVE_PREFIXES,
} from "./header-active-routes.ts";
import { nextLinkHref } from "./next-link-href.ts";

// The marketing header's Products and Resources mega-menus (see header.tsx).

/**
 * Origin for the menus' site-relative links. Empty on ryuhq.com itself; the
 * docs site renders the same menus under its own domain and provides the main
 * site's URL, so every link leaves the docs for the right ryuhq.com page.
 */
export const HeaderLinkOrigin = createContext("");

/** A menu link element: a Next Link on the site, a plain anchor off it. */
function menuLink(
	origin: string,
	href: string,
	external = false
): ReactElement<{ className?: string }> {
	const target = external
		? { rel: "noopener noreferrer", target: "_blank" as const }
		: {};
	if (origin && href.startsWith("/")) {
		return (
			<a data-cuelume-hover="tick" href={`${origin}${href}`} {...target} />
		);
	}
	return (
		<Link data-cuelume-hover="tick" href={nextLinkHref(href)} {...target} />
	);
}

export function LocalizedHeaderCopy({ value }: { value: string }) {
	return <>{useLocalizedText(value, { literal: true })}</>;
}

// Menus list bare names in large type under a small group label, the way
// Apple's global nav does; the destination pages carry the explanations.
const MENU_ITEM_CLASS =
	"font-medium text-foreground text-xl tracking-tight transition-colors hover:text-accent-foreground";
const MENU_GROUP_TITLE_CLASS =
	"mb-2 px-3 font-medium text-muted-foreground text-sm";
// Menu items and their hover highlight are pills, like the triggers and the
// top-bar links beside them.
const MENU_PILL_CLASS = "rounded-full";

function ProductLinkGroup({ group }: { group: ProductNavGroup }) {
	const localizedTitle = useLocalizedText(group.title, { literal: true });
	const origin = use(HeaderLinkOrigin);
	return (
		<div data-product-group={group.title}>
			<p className={MENU_GROUP_TITLE_CLASS}>{localizedTitle}</p>
			<div>
				{group.items.map((item) => (
					<MotionNavigationMenuLink
						className={MENU_PILL_CLASS}
						key={item.href}
						render={menuLink(origin, item.href)}
						spacing="compact"
					>
						<span className={MENU_ITEM_CLASS}>
							<LocalizedHeaderCopy value={item.label} />
						</span>
					</MotionNavigationMenuLink>
				))}
			</div>
		</div>
	);
}

function MenuFooterLink({ href, label }: { href: string; label: string }) {
	const origin = use(HeaderLinkOrigin);
	return (
		<MotionNavigationMenuLink
			className={MENU_PILL_CLASS}
			render={menuLink(origin, href)}
			spacing="horizontal"
		>
			<span className="font-medium text-foreground text-sm">
				<LocalizedHeaderCopy value={label} />
			</span>
		</MotionNavigationMenuLink>
	);
}

function PrimaryProductLinks({
	hiddenProductIds,
}: {
	hiddenProductIds: readonly string[];
}) {
	return (
		<div className="w-max p-2">
			<div className="grid auto-cols-[minmax(9rem,max-content)] grid-flow-col gap-x-12">
				{productMenuGroupsFor(hiddenProductIds).map((group) => (
					<ProductLinkGroup group={group} key={group.title} />
				))}
			</div>
			<div
				className="mt-6 flex items-center gap-2"
				data-testid="product-menu-explore"
			>
				<MenuFooterLink href="/products" label="All products →" />
				<MenuFooterLink href="/platform" label="How it fits together →" />
			</div>
		</div>
	);
}

export function ProductsMenu({
	hiddenProductIds,
	pathname,
}: {
	hiddenProductIds: readonly string[];
	pathname: string;
}) {
	const productsLabel = useLocalizedText("Products", { literal: true });
	const active = isWithinPrefixes(pathname, PRODUCT_ACTIVE_PREFIXES);
	return (
		<>
			<MotionNavigationMenuTrigger
				data-active={active ? "true" : undefined}
				tone={active ? "muted" : undefined}
			>
				{productsLabel}
			</MotionNavigationMenuTrigger>
			<MotionNavigationMenuContent highlightClassName={MENU_PILL_CLASS}>
				<PrimaryProductLinks hiddenProductIds={hiddenProductIds} />
			</MotionNavigationMenuContent>
		</>
	);
}

/** Same item style as the Products menu: the bare name in large type. */
function ResourceLink({
	resource,
}: {
	resource: Pick<Resource, "external" | "href" | "label">;
}) {
	const origin = use(HeaderLinkOrigin);
	return (
		<MotionNavigationMenuLink
			className={MENU_PILL_CLASS}
			render={menuLink(origin, resource.href, resource.external)}
			spacing="compact"
		>
			<span className={MENU_ITEM_CLASS}>
				<LocalizedHeaderCopy value={resource.label} />
			</span>
		</MotionNavigationMenuLink>
	);
}

export function ResourcesMenu({ pathname }: { pathname: string }) {
	const resourcesLabel = useLocalizedText("Resources", { literal: true });
	const active = isWithinPrefixes(pathname, RESOURCE_ACTIVE_PREFIXES);
	return (
		<>
			<MotionNavigationMenuTrigger
				data-active={active ? "true" : undefined}
				tone={active ? "muted" : undefined}
			>
				{resourcesLabel}
			</MotionNavigationMenuTrigger>
			<MotionNavigationMenuContent highlightClassName={MENU_PILL_CLASS}>
				<div className="grid w-max auto-cols-[minmax(9rem,max-content)] grid-flow-col gap-x-12 p-2">
					<div data-resource-group="Plans">
						<p className={MENU_GROUP_TITLE_CLASS}>
							<LocalizedHeaderCopy value="Plans" />
						</p>
						{PLAN_LINKS.map((link) => (
							<ResourceLink key={link.href} resource={link} />
						))}
					</div>
					{resourceCategories.map((category) => (
						<div data-resource-group={category} key={category}>
							<p className={MENU_GROUP_TITLE_CLASS}>
								<LocalizedHeaderCopy value={category} />
							</p>
							{resourcesByCategory(category).map((resource) => (
								<ResourceLink key={resource.href} resource={resource} />
							))}
						</div>
					))}
				</div>
			</MotionNavigationMenuContent>
		</>
	);
}

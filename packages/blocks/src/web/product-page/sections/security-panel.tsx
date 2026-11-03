import { cn } from "@ryu/ui/lib/utils";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { LinkArrow } from "../../link-arrow.tsx";
import { nextLinkHref } from "../../next-link-href.ts";
import type { ProductSecurityPanel as SecurityPanel } from "../profile-types.ts";
import {
	ProductSection,
	sectionBodyClass,
	sectionItemTitleClass,
	sectionSurfaceClass,
} from "./section-shell.tsx";

/** Where the trust material lives; both routes ship with apps/web. */
export const SECURITY_LINKS = [
	{ label: "Security at Ryu", href: "/security", page: true },
	{ label: "security.txt", href: "/.well-known/security.txt", page: false },
] as const;

const linkClass =
	"group inline-flex min-h-10 items-center gap-1.5 font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A short trust panel: the product's own security points (when its profile
 * names any) and the links to the security overview and disclosure policy.
 */
export function ProductSecurityPanel({
	security,
}: {
	security?: SecurityPanel;
}) {
	const points = security?.points ?? [];
	return (
		<ProductSection testId="product-security">
			<div
				className={cn(
					sectionSurfaceClass,
					"grid gap-8 p-6 md:p-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-16"
				)}
				data-product-card=""
			>
				<div className="min-w-0">
					<span
						aria-hidden="true"
						className="mb-5 flex size-10 items-center justify-center rounded-xl bg-background text-foreground"
					>
						<ShieldCheck className="size-5" />
					</span>
					<h2 className="font-heading font-medium text-foreground text-xl tracking-tight md:text-2xl">
						Security and disclosure
					</h2>
					{points.length ? (
						<ul className="mt-6 grid gap-3 sm:grid-cols-2">
							{points.map((point) => (
								<li
									className={cn(sectionBodyClass, "flex gap-3")}
									key={point.text}
								>
									<span
										aria-hidden="true"
										className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground"
									/>
									{point.text}
								</li>
							))}
						</ul>
					) : (
						<p className={cn(sectionBodyClass, "mt-3 max-w-xl")}>
							How Ryu handles security, and where to report a vulnerability.
						</p>
					)}
				</div>
				<ul className="flex flex-col gap-1 lg:min-w-56">
					{SECURITY_LINKS.map((link) => (
						<li key={link.href}>
							{link.page ? (
								<Link className={linkClass} href={nextLinkHref(link.href)}>
									<span className={sectionItemTitleClass}>{link.label}</span>
									<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
								</Link>
							) : (
								// A plain text file, not a page: no client-side navigation.
								<a className={linkClass} href={link.href}>
									<span className="font-mono text-foreground text-sm">
										{link.label}
									</span>
									<LinkArrow className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:rtl:-translate-x-0.5" />
								</a>
							)}
						</li>
					))}
				</ul>
			</div>
		</ProductSection>
	);
}

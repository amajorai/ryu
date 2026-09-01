/**
 * The fixed Ryu App UI vocabulary for Companion surfaces.
 *
 * These components intentionally describe app roles rather than expose an
 * escape hatch for every CSS decision. Agents and satellites may choose the
 * domain content, but shell, list, detail, form, empty, and action treatment
 * stay on one Ryu-owned visual contract.
 */

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps, ReactNode } from "react";

export const RYU_APP_UI_VERSION = "v1" as const;

export const RYU_APP_UI_SURFACES = ["standard", "editor", "canvas"] as const;
export type RyuAppSurface = (typeof RYU_APP_UI_SURFACES)[number];

export const RYU_APP_UI_PRIMITIVES = [
	"RyuAppShell",
	"RyuAppToolbar",
	"RyuAppMain",
	"RyuAppSection",
	"RyuAppList",
	"RyuAppListSection",
	"RyuAppListItem",
	"RyuAppDetail",
	"RyuAppForm",
	"RyuAppField",
	"RyuAppEmpty",
	"RyuAppActions",
] as const;

export const RYU_APP_UI_AGENT_RULES = [
	"Use RyuAppShell and the Ryu App UI primitives for every Companion surface.",
	"Use @ryu/ui controls for buttons, inputs, dialogs, menus, badges, and status.",
	"Use ConnectionStatusToast from @ryu/ui/components/connection-status for host-provided network or node states; keep the app mounted while live work waits.",
	"Use semantic Ryu tokens; do not invent raw colors, radii, shadows, or typography scales.",
	"Keep Marketplace listing copy out of the Companion; open directly into the working surface.",
	"Every async surface must provide loading, empty, error, and disabled states.",
	"Keep domain-specific layout inside standard, editor, or canvas surface modes.",
] as const;

interface RyuAppShellProps extends ComponentProps<"div"> {
	density?: "compact" | "comfortable";
	surface?: RyuAppSurface;
}

export function RyuAppShell({
	children,
	className,
	density = "compact",
	surface = "standard",
	...props
}: RyuAppShellProps) {
	return (
		<div
			{...props}
			className={cn("ryu-app-shell", className)}
			data-density={density}
			data-ryu-app-ui={RYU_APP_UI_VERSION}
			data-ryu-surface={surface}
		>
			{children}
		</div>
	);
}

interface RyuAppToolbarProps extends Omit<ComponentProps<"header">, "title"> {
	actions?: ReactNode;
	title?: ReactNode;
}

export function RyuAppToolbar({
	actions,
	children,
	className,
	title,
	...props
}: RyuAppToolbarProps) {
	return (
		<header {...props} className={cn("ryu-app-toolbar", className)}>
			{title ? <h1 className="ryu-app-toolbar__title">{title}</h1> : null}
			{children}
			{actions ? (
				<div className="ryu-app-toolbar__actions">{actions}</div>
			) : null}
		</header>
	);
}

export function RyuAppMain({ className, ...props }: ComponentProps<"main">) {
	return <main {...props} className={cn("ryu-app-main", className)} />;
}

interface RyuAppSectionProps extends Omit<ComponentProps<"section">, "title"> {
	title?: ReactNode;
}

export function RyuAppSection({
	children,
	className,
	title,
	...props
}: RyuAppSectionProps) {
	return (
		<section {...props} className={cn("ryu-app-section", className)}>
			{title ? <h2 className="ryu-app-section__heading">{title}</h2> : null}
			{children}
		</section>
	);
}

export function RyuAppList({
	"aria-label": ariaLabel,
	className,
	...props
}: ComponentProps<"div">) {
	return (
		<div
			{...props}
			aria-label={ariaLabel}
			className={cn("ryu-app-list", className)}
			role="listbox"
		/>
	);
}

interface RyuAppListSectionProps
	extends Omit<ComponentProps<"section">, "title"> {
	title?: ReactNode;
}

export function RyuAppListSection({
	children,
	className,
	title,
	...props
}: RyuAppListSectionProps) {
	return (
		<section {...props} className={cn("ryu-app-list__section", className)}>
			{title ? <h2 className="ryu-app-list__section-title">{title}</h2> : null}
			{children}
		</section>
	);
}

interface RyuAppListItemProps
	extends Omit<ComponentProps<"button">, "children" | "title"> {
	accessories?: ReactNode;
	icon?: ReactNode;
	selected?: boolean;
	subtitle?: ReactNode;
	title: ReactNode;
}

export function RyuAppListItem({
	accessories,
	className,
	icon,
	selected = false,
	subtitle,
	title,
	...props
}: RyuAppListItemProps) {
	return (
		<button
			{...props}
			aria-selected={selected}
			className={cn("ryu-app-list__item", className)}
			data-selected={selected ? "true" : "false"}
			role="option"
			type="button"
		>
			{icon ? <span className="ryu-app-list__item-icon">{icon}</span> : null}
			<span className="ryu-app-list__item-content">
				<span className="ryu-app-list__item-title">{title}</span>
				{subtitle ? (
					<span className="ryu-app-list__item-subtitle">{subtitle}</span>
				) : null}
			</span>
			{accessories ? (
				<span className="ryu-app-list__item-accessories">{accessories}</span>
			) : null}
		</button>
	);
}

export function RyuAppDetail({ className, ...props }: ComponentProps<"aside">) {
	return <aside {...props} className={cn("ryu-app-detail", className)} />;
}

export function RyuAppForm({ className, ...props }: ComponentProps<"form">) {
	return <form {...props} className={cn("ryu-app-form", className)} />;
}

interface RyuAppFieldProps extends ComponentProps<"div"> {
	description?: ReactNode;
	label: ReactNode;
}

export function RyuAppField({
	children,
	className,
	description,
	label,
	...props
}: RyuAppFieldProps) {
	return (
		<div {...props} className={cn("ryu-app-field", className)}>
			<span className="ryu-app-field__label">{label}</span>
			{children}
			{description ? (
				<span className="ryu-app-field__description">{description}</span>
			) : null}
		</div>
	);
}

interface RyuAppEmptyProps extends Omit<ComponentProps<"div">, "title"> {
	actions?: ReactNode;
	description?: ReactNode;
	title: ReactNode;
}

export function RyuAppEmpty({
	actions,
	children,
	className,
	description,
	title,
	...props
}: RyuAppEmptyProps) {
	return (
		<div {...props} className={cn("ryu-app-empty", className)}>
			<h2 className="ryu-app-empty__title">{title}</h2>
			{description ? (
				<p className="ryu-app-empty__description">{description}</p>
			) : null}
			{children}
			{actions ? <div className="ryu-app-empty__actions">{actions}</div> : null}
		</div>
	);
}

export function RyuAppActions({ className, ...props }: ComponentProps<"div">) {
	return <div {...props} className={cn("ryu-app-actions", className)} />;
}

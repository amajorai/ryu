"use client";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import styles from "./app-ui.module.css";

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
import type {
	RyuCompanionI18n,
	RyuCompanionWindowApi,
} from "@ryu/app-host/companion-contracts";
import type { MessageOverlays } from "@ryu/i18n/core";
import {
	I18nProvider,
	useI18n,
	useLocalizedString,
	useLocalizedText,
} from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useTimezoneRevision } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef } from "react";

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
	/** Optional host locale for standalone companion previews and tests. */
	initialLocale?: string | null;
	/**
	 * The app's own message catalogs (locale → English literal → text),
	 * layered under the host's language pack so the app's copy follows the
	 * host language too.
	 */
	messageOverlays?: MessageOverlays;
	surface?: RyuAppSurface;
}

/** The Companion iframe publishes this complete protocol in its own realm. */
declare const window: Omit<Window, "ryu"> & { ryu?: RyuCompanionWindowApi };

function companionI18nBridge(): RyuCompanionI18n | null {
	if (globalThis.window === undefined) {
		return null;
	}
	return window.ryu?.i18n ?? null;
}

/** Mirror the host's selected pack into standalone Companion shells. */
function CompanionI18nSync({ children }: { children: ReactNode }) {
	const i18n = useI18n();
	const i18nRef = useRef(i18n);
	i18nRef.current = i18n;

	useEffect(() => {
		const bridge = companionI18nBridge();
		if (!bridge) {
			return;
		}
		let disposed = false;
		const applySnapshot = (
			snapshot: Awaited<ReturnType<typeof bridge.get>>
		) => {
			if (disposed) {
				return;
			}
			const current = i18nRef.current;
			document.documentElement.style.setProperty(
				"--ryu-locale",
				snapshot.locale
			);
			if (
				snapshot.packId &&
				current.availablePacks.some((pack) => pack.id === snapshot.packId)
			) {
				if (current.selectedPackId !== snapshot.packId) {
					current.selectPack(snapshot.packId);
				}
				return;
			}
			if (
				current.locale !== snapshot.locale ||
				current.selectedPackId !== null
			) {
				current.setLocale(snapshot.locale);
			}
		};
		document.documentElement.style.setProperty(
			"--ryu-locale",
			i18nRef.current.locale
		);

		void bridge
			.get()
			.then(applySnapshot)
			.catch(() => undefined);
		let subscription: { dispose(): void } | undefined;
		try {
			subscription = bridge.subscribe({
				onChange: applySnapshot,
			});
		} catch {
			// The host may tear down a frame while the initial RPC is in flight.
		}
		return () => {
			disposed = true;
			subscription?.dispose();
		};
	}, []);

	return <>{children}</>;
}

export function RyuAppShell({
	children,
	className,
	density = "compact",
	initialLocale,
	messageOverlays,
	surface = "standard",
	...props
}: RyuAppShellProps) {
	// Date/time formatters are pure functions, so the shell owns the single
	// subscription that makes every app repaint when Desktop changes its display
	// zone or locale through the host bridge.
	useTimezoneRevision();
	return (
		<I18nProvider
			initialLocale={
				initialLocale ??
				(globalThis.navigator === undefined ? null : navigator.language)
			}
			{...(messageOverlays ? { overlays: messageOverlays } : {})}
		>
			<CompanionI18nSync>
				<I18nDirectionProvider>
					<TooltipProvider>
						<div
							{...props}
							className={cn(styles.shell, className)}
							data-density={density}
							data-ryu-app-ui={RYU_APP_UI_VERSION}
							data-ryu-surface={surface}
						>
							{children}
						</div>
					</TooltipProvider>
				</I18nDirectionProvider>
			</CompanionI18nSync>
		</I18nProvider>
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
	const localizedTitle = useLocalizedText(title, { literal: true });
	return (
		<header {...props} className={cn(styles.toolbar, className)}>
			{title ? <h1 className={styles.toolbarTitle}>{localizedTitle}</h1> : null}
			{children}
			{actions ? <div className={styles.toolbarActions}>{actions}</div> : null}
		</header>
	);
}

export function RyuAppMain({ className, ...props }: ComponentProps<"main">) {
	return <main {...props} className={cn(styles.main, className)} />;
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
	const localizedTitle = useLocalizedText(title, { literal: true });
	return (
		<section {...props} className={cn(styles.section, className)}>
			{title ? (
				<h2 className={styles.sectionHeading}>{localizedTitle}</h2>
			) : null}
			{children}
		</section>
	);
}

export function RyuAppList({
	"aria-label": ariaLabel,
	className,
	...props
}: ComponentProps<"div">) {
	const localizedAriaLabel = useLocalizedString(
		isNativeText(ariaLabel) ? ariaLabel : undefined
	);
	return (
		<div
			{...props}
			aria-label={localizedAriaLabel}
			className={cn(styles.list, className)}
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
	const localizedTitle = useLocalizedText(title, { literal: true });
	return (
		<section {...props} className={cn(styles.listSection, className)}>
			{title ? (
				<h2 className={styles.listSectionTitle}>{localizedTitle}</h2>
			) : null}
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
	const localizedTitle = useLocalizedText(title, { literal: true });
	const localizedSubtitle = useLocalizedText(subtitle, { literal: true });
	return (
		<button
			{...props}
			aria-selected={selected}
			className={cn(styles.listItem, className)}
			data-selected={selected ? "true" : "false"}
			role="option"
			type="button"
		>
			{icon ? <span className={styles.listItemIcon}>{icon}</span> : null}
			<span className={styles.listItemContent}>
				<span className={styles.listItemTitle}>{localizedTitle}</span>
				{subtitle ? (
					<span className={styles.listItemSubtitle}>{localizedSubtitle}</span>
				) : null}
			</span>
			{accessories ? (
				<span className={styles.listItemAccessories}>{accessories}</span>
			) : null}
		</button>
	);
}

export function RyuAppDetail({ className, ...props }: ComponentProps<"aside">) {
	return <aside {...props} className={cn(styles.detail, className)} />;
}

export function RyuAppForm({ className, ...props }: ComponentProps<"form">) {
	return <form {...props} className={cn(styles.form, className)} />;
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
	const localizedLabel = useLocalizedText(label, { literal: true });
	const localizedDescription = useLocalizedText(description, { literal: true });
	return (
		<div {...props} className={cn(styles.field, className)}>
			<span className={styles.fieldLabel}>{localizedLabel}</span>
			{children}
			{description ? (
				<span className={styles.fieldDescription}>{localizedDescription}</span>
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
	const localizedTitle = useLocalizedText(title, { literal: true });
	const localizedDescription = useLocalizedText(description, { literal: true });
	return (
		<div {...props} className={cn(styles.empty, className)}>
			<h2 className={styles.emptyTitle}>{localizedTitle}</h2>
			{description ? (
				<p className={styles.emptyDescription}>{localizedDescription}</p>
			) : null}
			{children}
			{actions ? <div className={styles.emptyActions}>{actions}</div> : null}
		</div>
	);
}

export function RyuAppActions({ className, ...props }: ComponentProps<"div">) {
	return <div {...props} className={cn(styles.actions, className)} />;
}

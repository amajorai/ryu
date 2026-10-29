"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { renderDropdownPopup } from "@ryu/ui/components/dropdown-menu-motion.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ComponentProps,
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "./drawer.tsx";
import {
	activateMobileSubmenuTrigger,
	mobileSubmenuItemProps,
	renderMobileSubmenuChildren,
} from "./dropdown-menu-mobile.ts";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";
import { usePortalContainer } from "./portal-container.tsx";

type MenuContent = MenuPrimitive.Popup.Props["children"];

interface MobileSubmenu {
	content?: MenuContent;
	title?: ReactNode;
}

interface DropdownMenuContextValue {
	goBack: () => void;
	isMobile: boolean;
	open: boolean;
	registerSubmenuContent: (id: string, content: MenuContent) => void;
	registerSubmenuTitle: (id: string, title: ReactNode) => void;
	setOpen: (open: boolean) => void;
	setSubmenuPath: Dispatch<SetStateAction<string[]>>;
	submenuPath: string[];
	submenus: ReadonlyMap<string, MobileSubmenu>;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(
	null
);
const DropdownMenuSubContext = createContext<string | null>(null);

function useDropdownMenuContext() {
	const context = useContext(DropdownMenuContext);
	if (!context) {
		throw new Error(
			"Dropdown menu parts must be rendered inside DropdownMenu."
		);
	}
	return context;
}

function createDrawerChangeDetails(): MenuPrimitive.Root.ChangeEventDetails {
	let cancelled = false;
	let propagationAllowed = false;
	return {
		reason: "imperative-action",
		event: new Event("dropdrawer-change"),
		trigger: undefined,
		get isCanceled() {
			return cancelled;
		},
		get isPropagationAllowed() {
			return propagationAllowed;
		},
		cancel() {
			cancelled = true;
		},
		allowPropagation() {
			propagationAllowed = true;
		},
		preventUnmountOnClose: () => undefined,
	};
}

function DropdownMenu({
	children,
	defaultOpen = false,
	modal,
	onOpenChange,
	open: controlledOpen,
	...props
}: MenuPrimitive.Root.Props) {
	const isMobile = useIsMobile();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
	const open = controlledOpen ?? uncontrolledOpen;
	const openRef = useRef(open);
	openRef.current = open;
	const [submenuPath, setSubmenuPath] = useState<string[]>([]);
	const [submenus, setSubmenus] = useState<Map<string, MobileSubmenu>>(
		() => new Map()
	);
	const setOpen = useCallback(
		(
			nextOpen: boolean,
			eventDetails?: MenuPrimitive.Root.ChangeEventDetails
		) => {
			if (openRef.current === nextOpen) {
				return;
			}
			const details = eventDetails ?? createDrawerChangeDetails();
			onOpenChange?.(nextOpen, details);
			if (details.isCanceled) {
				return;
			}
			openRef.current = nextOpen;
			if (controlledOpen === undefined) {
				setUncontrolledOpen(nextOpen);
			}
			if (!nextOpen) {
				setSubmenuPath([]);
			}
		},
		[controlledOpen, onOpenChange]
	);
	const registerSubmenuTitle = useCallback((id: string, title: ReactNode) => {
		setSubmenus((current) => {
			if (current.get(id)?.title === title) {
				return current;
			}
			const next = new Map(current);
			next.set(id, { ...next.get(id), title });
			return next;
		});
	}, []);
	const registerSubmenuContent = useCallback(
		(id: string, content: MenuContent) => {
			setSubmenus((current) => {
				if (current.get(id)?.content === content) {
					return current;
				}
				const next = new Map(current);
				next.set(id, { ...next.get(id), content });
				return next;
			});
		},
		[]
	);
	const goBack = useCallback(() => {
		setSubmenuPath((current) => current.slice(0, -1));
	}, []);
	const context = {
		goBack,
		isMobile,
		open,
		registerSubmenuContent,
		registerSubmenuTitle,
		setOpen,
		setSubmenuPath,
		submenuPath,
		submenus,
	};

	const menu = (
		<DropdownMenuContext.Provider value={context}>
			<MenuPrimitive.Root
				data-slot="dropdown-menu"
				{...props}
				defaultOpen={undefined}
				modal={isMobile ? false : modal}
				onOpenChange={(nextOpen, eventDetails) =>
					setOpen(nextOpen, eventDetails)
				}
				open={open}
			>
				{children}
			</MenuPrimitive.Root>
		</DropdownMenuContext.Provider>
	);

	const mobileDrawerProps: ComponentProps<typeof Drawer> = {
		onOpenChange: setOpen,
		open,
	};
	if (modal !== undefined) {
		mobileDrawerProps.modal = modal;
	}

	return isMobile ? <Drawer {...mobileDrawerProps}>{menu}</Drawer> : menu;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
	return (
		<MenuPrimitive.Portal
			container={usePortalContainer()}
			data-slot="dropdown-menu-portal"
			{...props}
		/>
	);
}

const nativeTriggerCallbackSchema = z.custom<
	Exclude<MenuPrimitive.Trigger.Props["className"], string | undefined>
>((value) => z.function().safeParse(value).success);
function mergeNavigationTriggerClasses(
	className: MenuPrimitive.Trigger.Props["className"],
	navigationClasses: string
): MenuPrimitive.Trigger.Props["className"] {
	const admitted = nativeTriggerCallbackSchema.safeParse(className);
	if (admitted.success) {
		const callback = admitted.data;
		return (state) => cn(navigationClasses, callback(state));
	}
	return cn(navigationClasses, z.string().optional().parse(className));
}

function DropdownMenuTrigger({
	children,
	className,
	variant = "default",
	motion = "none",
	reveal,
	activeHighlight = false,
	navigationState = "inactive",
	navigationContrast = "normal",
	selected = false,
	...props
}: MenuPrimitive.Trigger.Props & {
	variant?:
		| "default"
		| "muted"
		| "glass"
		| "navigation"
		| "panel-picker"
		| "panel-action"
		| "breadcrumbs"
		| "chat-picker"
		| "conversation-action"
		| "account-picker"
		| "queue-message-options"
		| "queue-options"
		| "account-row"
		| "sidebar-options"
		| "rounded-control"
		| "dialog-control"
		| "blurred-control"
		| "toolkit-picker"
		| "conversation-options"
		| "organization-picker";
	selected?: boolean;
	navigationState?: "active" | "inactive";
	navigationContrast?: "normal" | "inverse";
	motion?: "none" | "color" | "opacity";
	reveal?: "section" | "subsection" | "thread";
	activeHighlight?: boolean;
}) {
	const desktopTriggerClasses =
		variant === "account-row"
			? "rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
			: variant === "sidebar-options"
				? "inline-flex h-6 w-6 items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
				: variant === "rounded-control"
					? "rounded-lg border px-3 py-2 text-sm"
					: variant === "dialog-control"
						? "inline-flex h-10 w-fit items-center justify-center rounded-full border px-4 font-medium text-sm transition-colors hover:bg-accent"
						: variant === "blurred-control"
							? "rounded-xl border border-border/70 bg-background/70 px-4 py-2 text-sm"
							: variant === "toolkit-picker"
								? "flex h-8 items-center rounded-lg border px-3 text-xs"
								: variant === "conversation-options"
									? "hidden h-5 w-5 shrink-0 items-center justify-center rounded outline-none hover:bg-accent focus-visible:inline-flex focus-visible:ring-2 focus-visible:ring-ring aria-expanded:inline-flex group-focus-within/row:inline-flex group-hover/row:inline-flex data-[popup-open]:inline-flex"
									: variant === "organization-picker"
										? "flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60"
										: undefined;
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.Trigger
			className={
				desktopTriggerClasses === undefined
					? variant === "queue-message-options"
						? mergeNavigationTriggerClasses(
								className,
								"size-5 rounded-sm text-base text-muted-foreground/70 hover:bg-muted hover:text-foreground"
							)
						: variant === "queue-options"
							? mergeNavigationTriggerClasses(
									className,
									"size-6 rounded-sm text-lg text-muted-foreground hover:bg-muted hover:text-foreground"
								)
							: variant === "chat-picker"
								? mergeNavigationTriggerClasses(
										className,
										"inline-flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 font-medium text-sm ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
									)
								: variant === "conversation-action"
									? mergeNavigationTriggerClasses(
											className,
											"inline-flex h-8 w-8 items-center justify-center rounded-md p-0 font-medium text-sm opacity-0 ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
										)
									: variant === "account-picker"
										? mergeNavigationTriggerClasses(
												className,
												"flex w-full items-center gap-3 rounded-lg bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
											)
										: variant === "navigation"
											? mergeNavigationTriggerClasses(
													className,
													cn(
														"inline-flex shrink-0 items-center justify-center rounded-full px-3 py-1 font-medium text-sm transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
														navigationState === "active"
															? navigationContrast === "inverse"
																? "bg-background text-foreground hover:bg-background/80"
																: "bg-foreground text-background hover:bg-foreground/80"
															: navigationContrast === "inverse"
																? "text-background/65 hover:bg-background/10 hover:text-background"
																: "text-foreground/60 hover:bg-foreground/5 hover:text-foreground",
														"gap-1.5"
													)
												)
											: variant === "default" &&
													motion === "none" &&
													!reveal &&
													!activeHighlight
												? className
												: cn(
														variant === "muted" &&
															"rounded text-muted-foreground hover:bg-accent hover:text-foreground",
														variant === "glass" &&
															"rounded-lg border border-glass-content/15 bg-glass-content/10 px-3 py-2 font-medium text-sm hover:bg-glass-content/15",
														motion === "color" && "transition-colors",
														motion === "opacity" && "transition-opacity",
														reveal === "section" &&
															"opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100 data-[popup-open]:opacity-100",
														reveal === "subsection" &&
															"opacity-0 focus-visible:opacity-100 group-hover/subsection:opacity-100 data-[popup-open]:opacity-100",
														reveal === "thread" &&
															"opacity-0 group-hover/thread:opacity-100",
														activeHighlight && "data-[popup-open]:bg-accent",
														variant === "panel-picker" &&
															"px-0.5 text-muted-foreground transition-colors hover:text-foreground",
														variant === "panel-action" &&
															"rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
														variant === "breadcrumbs" &&
															"gap-1.5 rounded-full px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/50 hover:text-foreground",
														className
													)
					: mergeNavigationTriggerClasses(
							className,
							cn(desktopTriggerClasses, selected && "bg-foreground/10")
						)
			}
			data-cuelume-toggle=""
			data-slot="dropdown-menu-trigger"
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
		</MenuPrimitive.Trigger>
	);
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	className,
	drawerLabel = "Menu",
	withBackdrop = true,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<
		MenuPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	> & {
		/** Accessible title shown in the mobile drawer. */
		drawerLabel?: string;
		/** Render the shared full-window backdrop for a top-level menu. */
		withBackdrop?: boolean;
	}) {
	const direction = useDirection();
	const portalContainer = usePortalContainer();
	const { goBack, isMobile, open, submenuPath, submenus } =
		useDropdownMenuContext();
	const popupRef = useRef<HTMLDivElement>(null);
	const previousPathRef = useRef(submenuPath);
	const activeSubmenuId = submenuPath.at(-1);
	const activeSubmenu = activeSubmenuId
		? submenus.get(activeSubmenuId)
		: undefined;
	useEffect(() => {
		const pathChanged = previousPathRef.current !== submenuPath;
		previousPathRef.current = submenuPath;
		if (!(isMobile && open && pathChanged)) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			popupRef.current
				?.querySelector<HTMLElement>(
					"[data-slot$='-item']:not([data-disabled='true']), [role='menuitem']:not([aria-disabled='true'])"
				)
				?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [isMobile, open, submenuPath]);
	if (isMobile) {
		return (
			<MenuPrimitive.Portal container={portalContainer}>
				<DrawerContent
					className={cn(
						"!max-h-[90dvh] !w-full !max-w-none !overflow-hidden !rounded-b-none !p-3"
					)}
					data-drawer-mode="true"
				>
					<DrawerHeader className="sr-only">
						<DrawerTitle className="text-left text-base">
							{activeSubmenu?.title ?? drawerLabel}
						</DrawerTitle>
					</DrawerHeader>
					<MenuPrimitive.Positioner
						align="center"
						className="!relative !inset-auto !top-auto !right-auto !bottom-auto !left-auto !z-auto !h-auto !w-full !min-w-0 !max-w-none !transform-none outline-none"
						side="bottom"
						sideOffset={0}
					>
						<MenuPrimitive.Popup
							className={cn(
								className,
								"!max-h-[calc(90dvh-6rem)] !w-full !min-w-0 !max-w-none !overflow-y-auto !overflow-x-hidden !rounded-none !border-0 !bg-transparent !p-0 !shadow-none !backdrop-blur-none text-popover-foreground outline-none **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!"
							)}
							data-drawer-mode="true"
							data-drawer-submenu={activeSubmenuId}
							data-slot="dropdown-menu-content"
							dir={direction}
							ref={popupRef}
							{...props}
						>
							{activeSubmenu && (
								<div className="flex min-h-11 items-center gap-2 px-2 py-1 text-left">
									<MenuPrimitive.Item
										aria-label="Back to previous menu"
										className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
										closeOnClick={false}
										data-slot="dropdown-menu-back"
										onClick={goBack}
									>
										<HugeiconsIcon
											aria-hidden="true"
											icon={ArrowLeft01Icon}
											strokeWidth={2}
										/>
									</MenuPrimitive.Item>
									<span
										className="font-medium text-base"
										data-slot="dropdown-menu-submenu-title"
									>
										{activeSubmenu.title}
									</span>
								</div>
							)}
							{activeSubmenu
								? activeSubmenu.content
								: activeSubmenuId
									? null
									: props.children}
						</MenuPrimitive.Popup>
					</MenuPrimitive.Positioner>
				</DrawerContent>
			</MenuPrimitive.Portal>
		);
	}
	return (
		<MenuPrimitive.Portal container={portalContainer}>
			{withBackdrop && (
				<MenuPrimitive.Backdrop
					className="ryu-popup-overlay"
					data-slot="dropdown-menu-overlay"
				/>
			)}
			<MenuPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				className="isolate z-50 outline-none"
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					className={cn(
						"corner-squircle before:corner-squircle relative z-50 max-h-[var(--available-height)] w-[var(--anchor-width)] min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden rounded-3xl border border-border/50 bg-muted/90 text-popover-foreground outline-none backdrop-blur-2xl backdrop-saturate-150 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-closed:overflow-hidden **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
						className
					)}
					data-slot="dropdown-menu-content"
					{...props}
					dir={direction}
					render={renderDropdownPopup}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
	children,
	className,
	inset,
	variant = "default",
	layout = "default",
	...props
}: MenuPrimitive.GroupLabel.Props & {
	inset?: boolean;
	variant?: "default" | "worktree-heading";
	layout?: "default" | "icon";
}) {
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.GroupLabel
			className={cn(
				"px-2 py-1.5 text-muted-foreground text-xs data-inset:ps-9.5",
				isMobile && "px-4 py-2 text-sm",
				variant === "worktree-heading" && "px-2 pt-1 pb-1 text-sm",
				layout === "icon" && "flex items-center gap-1.5",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-label"
			{...props}
		>
			{localizedChildren}
		</MenuPrimitive.GroupLabel>
	);
}

function DropdownMenuItem({
	children,
	className,
	inset,
	variant = "default",
	spacing = "default",
	density = "default",
	tone = "default",
	active = false,
	layout = "default",
	purpose = "default",
	selected = false,
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean;
	spacing?: "default" | "tight" | "comfortable" | "spacious";
	density?: "default" | "compact";
	tone?: "default" | "muted" | "foreground" | "destructive";
	active?: boolean;
	layout?: "default" | "detail-stack";
	variant?: "default" | "destructive";
	purpose?:
		| "default"
		| "composer-model"
		| "app-version"
		| "interface-level"
		| "layer-action"
		| "provider-heading"
		| "node-choice";
	selected?: boolean;
}) {
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.Item
			className={cn(
				"group/dropdown-menu-item corner-squircle relative flex w-full cursor-default select-none items-center gap-1.5 rounded-2xl px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-[variant=destructive]:text-status-destructive data-disabled:opacity-50 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-status-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 data-[variant=destructive]:*:[svg]:text-status-destructive",
				isMobile &&
					"min-h-[44px] px-4 py-2.5 text-base [&_svg:not([class*='size-'])]:size-5",
				active && "bg-foreground/10",
				spacing === "tight" && "gap-0.5",
				spacing === "comfortable" && "gap-2",
				spacing === "spacious" && "gap-2.5",
				density === "compact" && "text-xs",
				tone === "muted" && "text-muted-foreground",
				tone === "foreground" && "text-foreground",
				layout === "detail-stack" && "flex flex-col items-start gap-1",
				purpose === "composer-model" && [
					"h-auto w-full items-center justify-start gap-1.5 rounded-2xl px-1.5 py-1 text-left font-medium text-sm",
					"flex-col items-start gap-0.5",
				],
				purpose === "app-version" && "py-1.5",
				purpose === "interface-level" && "py-2",
				purpose === "layer-action" && "py-1",
				purpose === "provider-heading" &&
					"type-compact rounded-md px-1 py-0 text-muted-foreground/50",
				purpose === "node-choice" &&
					"items-start gap-2 rounded-lg px-2.5 py-2.5",
				tone === "destructive" && "text-status-destructive",
				selected && "bg-accent",
				className
			)}
			data-cuelume-toggle=""
			data-inset={inset}
			data-slot="dropdown-menu-item"
			data-variant={variant}
			{...props}
		>
			{localizedChildren}
		</MenuPrimitive.Item>
	);
}

function DropdownMenuSub({
	children,
	defaultOpen = false,
	open: controlledOpen,
	...props
}: MenuPrimitive.SubmenuRoot.Props) {
	const { isMobile, setSubmenuPath } = useDropdownMenuContext();
	const submenuId = useId();
	useEffect(() => {
		if (!isMobile || (controlledOpen === undefined && !defaultOpen)) {
			return;
		}
		setSubmenuPath((current) => {
			const currentIndex = current.indexOf(submenuId);
			if (controlledOpen ?? defaultOpen) {
				if (currentIndex === current.length - 1) {
					return current;
				}
				const nextIndex = currentIndex < 0 ? current.length : currentIndex;
				return [...current.slice(0, nextIndex), submenuId];
			}
			return currentIndex < 0 ? current : current.slice(0, currentIndex);
		});
	}, [controlledOpen, defaultOpen, isMobile, setSubmenuPath, submenuId]);
	if (isMobile) {
		const submenuChildren = renderMobileSubmenuChildren(children);
		return (
			<DropdownMenuSubContext.Provider value={submenuId}>
				{submenuChildren}
			</DropdownMenuSubContext.Provider>
		);
	}
	return (
		<DropdownMenuSubContext.Provider value={submenuId}>
			<MenuPrimitive.SubmenuRoot
				data-slot="dropdown-menu-sub"
				{...props}
				defaultOpen={defaultOpen}
				open={controlledOpen}
			>
				{children}
			</MenuPrimitive.SubmenuRoot>
		</DropdownMenuSubContext.Provider>
	);
}

function DropdownMenuSubTrigger({
	className,
	spacing = "default",
	density = "default",
	purpose = "default",
	active = false,
	tone = "default",
	inset,
	children,
	onClick,
	render,
	style,
	delay,
	closeDelay,
	openOnHover,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean;
	purpose?: "default" | "layer-selection";
	active?: boolean;
	spacing?: "default" | "comfortable" | "spacious";
	density?: "default" | "compact";
	tone?: "default" | "muted" | "foreground";
}) {
	const { isMobile, registerSubmenuTitle, setSubmenuPath, submenuPath } =
		useDropdownMenuContext();
	const submenuId = useContext(DropdownMenuSubContext);
	useEffect(() => {
		if (isMobile && submenuId) {
			registerSubmenuTitle(submenuId, children);
		}
	}, [children, isMobile, registerSubmenuTitle, submenuId]);
	const localizedChildren = useLocalizedText(children, { literal: true });
	if (isMobile) {
		if (!submenuId) {
			throw new Error("Submenu trigger must be inside DropdownMenuSub.");
		}
		const mobileProps = mobileSubmenuItemProps(
			{ render, style },
			submenuPath.at(-1) === submenuId
		);
		return (
			<MenuPrimitive.Item
				aria-expanded={submenuPath.at(-1) === submenuId}
				aria-haspopup="menu"
				className={cn(
					"flex min-h-[44px] cursor-default select-none items-center gap-1.5 rounded-2xl px-4 py-2.5 font-medium text-base outline-hidden focus:bg-accent focus:text-accent-foreground data-inset:ps-9.5 [&_svg:not([class*='size-'])]:size-5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
					spacing === "comfortable" && "gap-2",
					spacing === "spacious" && "gap-2.5",
					density === "compact" && "text-xs",
					tone === "muted" && "text-muted-foreground",
					tone === "foreground" && "text-foreground",
					purpose === "layer-selection" && "gap-2 py-1 font-normal text-xs",
					active && "bg-foreground/10",
					className
				)}
				closeOnClick={false}
				data-inset={inset}
				data-slot="dropdown-menu-sub-trigger"
				onClick={(event) => {
					if (activateMobileSubmenuTrigger(event, onClick)) {
						setSubmenuPath((current) => [...current, submenuId]);
					}
				}}
				{...mobileProps}
				{...props}
			>
				<FadeOverflowTextChildren className="flex-1">
					{localizedChildren}
				</FadeOverflowTextChildren>
				<HugeiconsIcon
					className="ms-auto rtl:rotate-180"
					icon={ArrowRight01Icon}
					strokeWidth={2}
				/>
			</MenuPrimitive.Item>
		);
	}
	return (
		<MenuPrimitive.SubmenuTrigger
			className={cn(
				"corner-squircle flex cursor-default select-none items-center gap-1.5 rounded-2xl px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-open:bg-accent data-popup-open:bg-accent data-inset:ps-9.5 data-open:text-accent-foreground data-popup-open:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				isMobile &&
					"min-h-[44px] px-4 py-2.5 text-base [&_svg:not([class*='size-'])]:size-5",
				spacing === "comfortable" && "gap-2",
				spacing === "spacious" && "gap-2.5",
				density === "compact" && "text-xs",
				tone === "muted" && "text-muted-foreground",
				tone === "foreground" && "text-foreground",
				purpose === "layer-selection" && "gap-2 py-1 font-normal text-xs",
				active && "bg-foreground/10",
				className
			)}
			closeDelay={closeDelay}
			data-inset={inset}
			data-slot="dropdown-menu-sub-trigger"
			delay={delay}
			onClick={onClick}
			openOnHover={openOnHover}
			style={style}
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
			<HugeiconsIcon
				className="ms-auto rtl:rotate-180"
				icon={ArrowRight01Icon}
				strokeWidth={2}
			/>
		</MenuPrimitive.SubmenuTrigger>
	);
}

function DropdownMenuSubContent({
	children,
	align = "start",
	alignOffset = -3,
	side = "inline-end",
	sideOffset = 0,
	className,
	...props
}: ComponentProps<typeof DropdownMenuContent>) {
	const { isMobile, registerSubmenuContent } = useDropdownMenuContext();
	const submenuId = useContext(DropdownMenuSubContext);
	useEffect(() => {
		if (isMobile && submenuId) {
			registerSubmenuContent(submenuId, children);
		}
	}, [children, isMobile, registerSubmenuContent, submenuId]);
	if (isMobile) {
		if (!submenuId) {
			throw new Error("Submenu content must be inside DropdownMenuSub.");
		}
		return null;
	}
	return (
		<DropdownMenuContent
			align={align}
			alignOffset={alignOffset}
			className={cn(
				"corner-squircle before:corner-squircle relative w-auto min-w-36 rounded-3xl border border-border/50 bg-muted/90 text-popover-foreground backdrop-blur-2xl backdrop-saturate-150 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
				className
			)}
			data-slot="dropdown-menu-sub-content"
			side={side}
			sideOffset={sideOffset}
			{...props}
			withBackdrop={false}
		>
			{children}
		</DropdownMenuContent>
	);
}

function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	inset,
	...props
}: MenuPrimitive.CheckboxItem.Props & {
	inset?: boolean;
}) {
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.CheckboxItem
			checked={checked}
			className={cn(
				"corner-squircle relative flex cursor-default select-none items-center gap-1.5 rounded-2xl py-1 ps-2 pe-8 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				isMobile &&
					"min-h-[44px] py-2.5 ps-4 text-base [&_svg:not([class*='size-'])]:size-5",
				className
			)}
			closeOnClick={isMobile}
			data-inset={inset}
			data-slot="dropdown-menu-checkbox-item"
			{...props}
		>
			<span
				className="pointer-events-none absolute end-2 flex items-center justify-center"
				data-slot="dropdown-menu-checkbox-item-indicator"
			>
				<MenuPrimitive.CheckboxItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{localizedChildren}
		</MenuPrimitive.CheckboxItem>
	);
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
	return (
		<MenuPrimitive.RadioGroup
			data-slot="dropdown-menu-radio-group"
			{...props}
		/>
	);
}

function DropdownMenuRadioItem({
	className,
	children,
	inset,
	...props
}: MenuPrimitive.RadioItem.Props & {
	inset?: boolean;
}) {
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.RadioItem
			className={cn(
				"corner-squircle relative flex cursor-default select-none items-center gap-1.5 rounded-2xl py-1 ps-2 pe-8 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				isMobile &&
					"min-h-[44px] py-2.5 ps-4 text-base [&_svg:not([class*='size-'])]:size-5",
				className
			)}
			closeOnClick={isMobile}
			data-inset={inset}
			data-slot="dropdown-menu-radio-item"
			{...props}
		>
			<span
				className="pointer-events-none absolute end-2 flex items-center justify-center"
				data-slot="dropdown-menu-radio-item-indicator"
			>
				<MenuPrimitive.RadioItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{localizedChildren}
		</MenuPrimitive.RadioItem>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			className={cn("mx-2 my-1 h-px bg-border/50", className)}
			data-slot="dropdown-menu-separator"
			{...props}
		/>
	);
}

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ms-auto text-muted-foreground text-xs tracking-widest group-focus/dropdown-menu-item:text-accent-foreground",
				className
			)}
			data-slot="dropdown-menu-shortcut"
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};

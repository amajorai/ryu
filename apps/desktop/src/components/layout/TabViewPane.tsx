import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, ReactNode } from "react";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { TabGlyph } from "./TitleBar.tsx";

interface TabPaneStyle extends CSSProperties {
	"--ryu-titlebar-inset": string;
}

export interface TabViewPaneProps {
	children?: ReactNode;
	className?: string;
	focused: boolean;
	onClose: () => void;
	onFocus: () => void;
	style?: CSSProperties;
	tab: Tab;
}

export function TabViewPane({
	children,
	className,
	focused,
	onClose,
	onFocus,
	style,
	tab,
}: TabViewPaneProps) {
	const tl = useLiteralMessages();
	return (
		<IsActiveTabProvider isActive={focused}>
			<CurrentTabIdProvider tabId={tab.id}>
				{/* an unfocused live pane must focus before its route controls handle the pointer event */}
				<section
					aria-label={tl("{title} tab", { title: tab.title })}
					className={cn(
						"relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
						className
					)}
					data-focused={focused}
					data-tab-view-pane={tab.id}
					onMouseDownCapture={
						focused
							? undefined
							: (event) => {
									if (
										event.button === 0 &&
										event.target instanceof Node &&
										event.currentTarget.contains(event.target)
									) {
										onFocus();
									}
								}
					}
					role="group"
					style={
						/* SAFETY: ReactDOM forwards these exact custom properties with style.setProperty; the complete TabPaneStyle producer checks all standard CSS fields and app slots, which React CSSProperties omits. */ {
							...style,
							"--ryu-titlebar-inset": "0px",
						} satisfies TabPaneStyle as CSSProperties
					}
				>
					{children}
					{tab.unloaded ? (
						<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
							<span
								className={cn(
									"size-8 text-muted-foreground/70",
									"inline-flex items-center justify-center"
								)}
							>
								<TabGlyph
									className="size-full"
									logoSize="32px"
									path={tab.path}
									unloaded
								/>
							</span>
							<div>
								<p className="font-medium text-sm">{tab.title}</p>
								<p className="mt-1 text-muted-foreground text-xs">
									This tab is unloaded to save memory.
								</p>
							</div>
							<button
								className="rounded-full border border-border/70 bg-background px-3 py-1.5 font-medium text-xs shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								onClick={onFocus}
								type="button"
							>
								Reload tab
							</button>
						</div>
					) : (
						<div className="min-h-0 min-w-0 flex-1 overflow-hidden">
							{/* Keyed on the in-place navigation token, like the standard
							    layout: pages such as ChatPage seed from props once on mount,
							    so a reused pane must remount to show the new conversation. */}
							<RouteOutlet
								key={tab.navToken ?? 0}
								onClose={onClose}
								tab={tab}
							/>
						</div>
					)}
				</section>
			</CurrentTabIdProvider>
		</IsActiveTabProvider>
	);
}

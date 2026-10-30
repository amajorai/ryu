import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	type Tab,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";

/**
 * Anything the user opened over an interface (Settings, the Marketplace, an
 * app, a deep link), shown as a page with a way back to the interface.
 */
export function InterfacePageOverlay({
	label,
	leaveTab,
	shownPageTab,
}: {
	label: string;
	leaveTab: (id: string) => void;
	shownPageTab: Tab;
}) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-label={shownPageTab.title || "Page"}
			className="absolute inset-0 z-20 flex flex-col bg-background"
			data-testid="ryu-interface-page"
		>
			<div className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-2">
				<Button
					onClick={() => leaveTab(shownPageTab.id)}
					size="sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon
						aria-hidden="true"
						data-icon="inline-start"
						icon={ArrowLeft01Icon}
					/>
					{tl("Back to {label}", { label })}
				</Button>
				<span
					className="min-w-0 truncate text-muted-foreground text-sm"
					title={shownPageTab.title}
				>
					{shownPageTab.title}
				</span>
			</div>
			<IsActiveTabProvider
				isActive
				key={`${shownPageTab.id}:${shownPageTab.navToken ?? 0}`}
			>
				<CurrentTabIdProvider tabId={shownPageTab.id}>
					<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
						<RouteOutlet
							onClose={() => leaveTab(shownPageTab.id)}
							tab={shownPageTab}
						/>
					</div>
				</CurrentTabIdProvider>
			</IsActiveTabProvider>
		</section>
	);
}

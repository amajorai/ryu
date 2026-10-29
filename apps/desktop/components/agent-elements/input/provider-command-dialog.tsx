"use client";

import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Command,
	CommandDialog,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/command.tsx";
import {
	cloneElement,
	createContext,
	type ReactElement,
	type ReactNode,
	useContext,
	useState,
} from "react";

export interface ProviderCommandPage {
	body: ReactNode;
	title: string;
}

interface ProviderCommandNavigation {
	close: () => void;
	page: ProviderCommandPage | null;
	pop: () => void;
	push: (page: ProviderCommandPage) => void;
}

export const ProviderCommandNavigationContext =
	createContext<ProviderCommandNavigation | null>(null);

export function useProviderCommandNavigation() {
	return useContext(ProviderCommandNavigationContext);
}

interface ProviderCommandDialogProps {
	renderBody: (close: () => void) => ReactNode;
	title?: string;
	trigger: ReactElement<{ onClick?: () => void }>;
}

/** Shared command-dialog shell for provider/model-capable settings fields. */
export function ProviderCommandDialog({
	renderBody,
	title = "Choose provider and model",
	trigger: children,
}: ProviderCommandDialogProps) {
	const [open, setOpen] = useState(false);
	const [pages, setPages] = useState<ProviderCommandPage[]>([]);
	const tl = useLiteralMessages();
	const page = pages.at(-1) ?? null;
	const close = () => {
		setPages([]);
		setOpen(false);
	};
	const navigation: ProviderCommandNavigation = {
		close,
		page,
		pop: () => setPages((current) => current.slice(0, -1)),
		push: (next) => setPages((current) => [...current, next]),
	};
	const trigger = cloneElement(children, {
		onClick: () => {
			setPages([]);
			setOpen(true);
		},
	});

	return (
		<>
			{trigger}
			<CommandDialog
				onOpenChange={(next) => (next ? setOpen(true) : close())}
				open={open}
				title={page?.title ?? title}
			>
				<Command>
					<CommandInput placeholder="Search providers and models…" />
					<CommandList className="max-h-[min(60vh,520px)]">
						{page && (
							<CommandItem
								forceMount
								onSelect={navigation.pop}
								value={`back to ${pages.at(-2)?.title ?? title}`}
							>
								<HugeiconsIcon
									icon={ArrowLeft01Icon}
									size={16}
									strokeWidth={2}
								/>
								<span className="truncate">
									{tl("Back to {pageTitle}", {
										pageTitle: pages.at(-2)?.title ?? title,
									})}
								</span>
							</CommandItem>
						)}
						<ProviderCommandNavigationContext.Provider value={navigation}>
							{page?.body ?? renderBody(close)}
						</ProviderCommandNavigationContext.Provider>
					</CommandList>
				</Command>
			</CommandDialog>
		</>
	);
}

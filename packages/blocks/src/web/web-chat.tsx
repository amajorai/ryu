"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";

const noop = () => {
	// presentational default; the live app injects real handlers
};

export interface WebChatProps {
	/** The composer / input region. */
	composer?: ReactNode;
	/** The message list region. */
	messages?: ReactNode;
	/** Whether the mobile sidebar overlay is open. */
	mobileSidebarOpen?: boolean;
	onCloseMobileSidebar?: () => void;
	onOpenMobileSidebar?: () => void;
	/** Agent + space selectors row in the header. */
	selectors?: ReactNode;
	/** Left conversation list (the live page renders its ChatSidebar). */
	sidebar?: ReactNode;
}

/**
 * The real /chat page layout, presentational. The live page
 * (apps/web/src/app/chat/page.tsx) owns useChat + the conversation store and
 * injects its ChatSidebar, selectors, ChatMessages, and ChatInput into the
 * slots. The storyboard fills the slots with static markup.
 */
export default function WebChat({
	sidebar,
	selectors,
	messages,
	composer,
	mobileSidebarOpen = false,
	onOpenMobileSidebar = noop,
	onCloseMobileSidebar = noop,
}: WebChatProps) {
	return (
		<div className="flex h-full overflow-hidden">
			<div className="hidden w-80 border-r md:block">{sidebar}</div>

			{mobileSidebarOpen && (
				<div className="fixed inset-0 z-50 md:hidden">
					<button
						aria-label="Close sidebar"
						className="absolute inset-0 bg-black/50"
						onClick={onCloseMobileSidebar}
						type="button"
					/>
					<div className="absolute top-0 bottom-0 left-0 w-80 border-r bg-background">
						{sidebar}
					</div>
				</div>
			)}

			<div className="flex flex-1 flex-col overflow-hidden">
				<div className="border-b p-4">
					<div className="flex items-center gap-4">
						<button
							aria-label="Open sidebar"
							className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent md:hidden"
							onClick={onOpenMobileSidebar}
							type="button"
						>
							<Menu size={20} />
						</button>

						<div className="flex flex-1 flex-wrap gap-2">{selectors}</div>
					</div>
				</div>

				{messages}

				<div className="border-t p-4">{composer}</div>
			</div>
		</div>
	);
}

import { Pencil } from "lucide-react";
import type { ReactNode } from "react";

/** The narrow-window navigation drawer with its click-away scrim. */
export function MailNavOverlay({
	children,
	onClose,
}: {
	children: ReactNode;
	onClose: () => void;
}) {
	return (
		<>
			<button
				aria-label="Close menu"
				className="absolute inset-0 z-20 bg-foreground/15"
				onClick={onClose}
				tabIndex={-1}
				type="button"
			/>
			<div className="absolute inset-y-0 left-0 z-30 flex bg-sidebar pt-2 shadow-xl">
				{children}
			</div>
		</>
	);
}

/** Gmail's floating Compose button, shown when the navigation is hidden. */
export function MailComposeFab({ onClick }: { onClick: () => void }) {
	return (
		<button
			aria-keyshortcuts="c"
			className="absolute right-4 bottom-4 isolate z-10 flex h-14 items-center gap-3 rounded-2xl bg-background pr-5 pl-4 font-medium text-foreground text-sm shadow-lg outline-none transition-shadow before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-primary/15 hover:shadow-xl focus-visible:ring-2 focus-visible:ring-ring/60"
			data-testid="mail-compose-fab"
			onClick={onClick}
			type="button"
		>
			<Pencil aria-hidden="true" className="size-5" strokeWidth={1.75} />
			Compose
		</button>
	);
}

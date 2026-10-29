import type { ReactNode } from "react";

/**
 * The homepage card backdrop every product scene draws inside. It is
 * decorative (`aria-hidden`); the card's own label and link carry the meaning.
 */
export function Scene({ children, id }: { children: ReactNode; id: string }) {
	return (
		<div
			aria-hidden="true"
			className="relative h-full w-full overflow-hidden bg-muted/65 text-foreground"
			data-testid={`realm-visual-${id}`}
		>
			{children}
		</div>
	);
}

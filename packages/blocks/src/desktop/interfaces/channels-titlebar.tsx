import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Search, X } from "lucide-react";
import type { KeyboardEvent } from "react";

/**
 * The window title bar: one centered search field on the sidebar surface.
 * Typing narrows the sidebar and the open channel's messages; Escape (or the
 * clear button) brings everything back.
 */
export function ChannelsTitleBar({
	onQueryChange,
	query,
}: {
	onQueryChange: (query: string) => void;
	query: string;
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape" && query) {
			event.preventDefault();
			onQueryChange("");
		}
	};
	return (
		<div className="flex h-11 shrink-0 items-center justify-center border-sidebar-border border-b bg-sidebar px-4 text-sidebar-foreground">
			<div
				className="relative flex w-full max-w-[560px] items-center"
				role="search"
			>
				<Search
					aria-hidden="true"
					className="pointer-events-none absolute left-2.5 z-10 size-4 text-foreground/60"
				/>
				<input
					aria-label="Search Ryu"
					autoComplete="off"
					className="h-8 w-full rounded-md border border-input bg-background pr-16 pl-8 text-foreground text-sm outline-hidden ring-ring/30 transition-[border-color,box-shadow] placeholder:text-foreground/60 hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 dark:bg-input/30 [&::-webkit-search-cancel-button]:hidden"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder="Search Ryu"
					spellCheck={false}
					type="search"
					value={query}
				/>
				{query ? (
					<span className="absolute right-1 flex items-center gap-1">
						<Kbd aria-hidden="true" className="h-5 text-foreground/70 text-xs">
							Esc
						</Kbd>
						<button
							aria-label="Clear search"
							className="inline-flex size-6 items-center justify-center rounded-md text-foreground/70 outline-hidden ring-sidebar-ring hover:bg-muted hover:text-foreground focus-visible:ring-2"
							onClick={() => onQueryChange("")}
							title="Clear search"
							type="button"
						>
							<X aria-hidden="true" className="size-3.5" />
						</button>
					</span>
				) : null}
			</div>
		</div>
	);
}

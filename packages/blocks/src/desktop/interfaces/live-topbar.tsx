import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Plus, Search, X } from "lucide-react";
import type { RefObject } from "react";

/**
 * The reference's top bar, trimmed to what Live needs: Browse on the left, the
 * search field in the middle, and New thread on the right.
 */
export function LiveTopBar({
	browsing,
	compact,
	onBrowse,
	onNew,
	onQuery,
	query,
	searchRef,
}: {
	browsing: boolean;
	compact: boolean;
	onBrowse: () => void;
	onNew: () => void;
	onQuery: (query: string) => void;
	query: string;
	searchRef: RefObject<HTMLInputElement | null>;
}) {
	return (
		<header className="relative z-20 flex h-12 shrink-0 items-center gap-4 border-border border-b bg-background px-4">
			<nav aria-label="Live" className="flex shrink-0 items-center">
				<button
					aria-current={browsing ? "page" : undefined}
					className={cn(
						"rounded-sm px-1 font-semibold text-base leading-6 outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring",
						browsing ? "text-primary" : "text-foreground"
					)}
					onClick={onBrowse}
					type="button"
				>
					Browse
				</button>
			</nav>
			<div className="flex min-w-0 flex-1 justify-center" role="search">
				<InputGroup className="h-9 w-full max-w-100 bg-muted">
					<InputGroupAddon>
						<Search aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						aria-label="Search channels and categories"
						autoComplete="off"
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.stopPropagation();
								onQuery("");
							}
						}}
						placeholder="Search"
						ref={searchRef}
						type="search"
						value={query}
					/>
					<InputGroupAddon align="inline-end">
						{query ? (
							<InputGroupButton
								aria-label="Clear search"
								onClick={() => {
									onQuery("");
									searchRef.current?.focus();
								}}
								size="icon-xs"
							>
								<X aria-hidden="true" />
							</InputGroupButton>
						) : (
							<Kbd aria-hidden="true">/</Kbd>
						)}
					</InputGroupAddon>
				</InputGroup>
			</div>
			{compact ? (
				<Button
					aria-label="New thread"
					onClick={onNew}
					size="icon-sm"
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" className="size-4" />
				</Button>
			) : (
				<Button onClick={onNew} size="sm" type="button" variant="outline">
					<Plus
						aria-hidden="true"
						className="size-4"
						data-icon="inline-start"
					/>
					New thread
				</Button>
			)}
		</header>
	);
}

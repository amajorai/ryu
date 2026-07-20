"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useAsRef } from "@ryu/ui/hooks/use-as-ref.ts";
import { useDebouncedCallback } from "@ryu/ui/hooks/use-debounced-callback.ts";
import type { SearchState } from "@ryu/ui/types/data-grid.ts";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
	type ChangeEvent,
	type CompositionEvent,
	type KeyboardEvent,
	memo,
	type PointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";

function onTriggerPointerDown(event: PointerEvent<HTMLButtonElement>) {
	const target = event.target;
	if (!(target instanceof HTMLElement)) {
		return;
	}
	if (target.hasPointerCapture(event.pointerId)) {
		target.releasePointerCapture(event.pointerId);
	}

	// Prevent the trigger from stealing focus away from the input
	if (
		event.button === 0 &&
		event.ctrlKey === false &&
		event.pointerType === "mouse" &&
		!(event.target instanceof HTMLInputElement)
	) {
		event.preventDefault();
	}
}

interface DataGridSearchProps extends SearchState {}

export const DataGridSearch = memo(DataGridSearchImpl, (prev, next) => {
	if (prev.searchOpen !== next.searchOpen) {
		return false;
	}

	if (!next.searchOpen) {
		return true;
	}

	// Exclude searchQuery because the input is uncontrolled, and hasQuery state handles the status text
	if (prev.matchIndex !== next.matchIndex) {
		return false;
	}

	if (prev.searchMatches.length !== next.searchMatches.length) {
		return false;
	}

	for (let i = 0; i < prev.searchMatches.length; i++) {
		const prevMatch = prev.searchMatches[i];
		const nextMatch = next.searchMatches[i];

		if (!(prevMatch && nextMatch)) {
			return false;
		}

		if (
			prevMatch.rowIndex !== nextMatch.rowIndex ||
			prevMatch.columnId !== nextMatch.columnId
		) {
			return false;
		}
	}

	return true;
});

function DataGridSearchImpl({
	searchMatches,
	matchIndex,
	searchOpen,
	onSearchOpenChange,
	searchQuery,
	onSearchQueryChange,
	onSearch,
	onNavigateToNextMatch,
	onNavigateToPrevMatch,
}: DataGridSearchProps) {
	const propsRef = useAsRef({
		onSearchOpenChange,
		onSearchQueryChange,
		onSearch,
		onNavigateToNextMatch,
		onNavigateToPrevMatch,
	});

	const inputRef = useRef<HTMLInputElement>(null);
	const isComposingRef = useRef(false);
	const [hasQuery, setHasQuery] = useState(searchQuery.length > 0);

	useEffect(() => {
		if (searchOpen) {
			requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
			return;
		}

		isComposingRef.current = false;
		setHasQuery(false);
	}, [searchOpen]);

	useEffect(() => {
		if (!searchOpen) {
			return;
		}

		function onEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				propsRef.current.onSearchOpenChange(false);
			}
		}

		document.addEventListener("keydown", onEscape);
		return () => document.removeEventListener("keydown", onEscape);
	}, [searchOpen, propsRef]);

	const debouncedSearch = useDebouncedCallback((query: string) => {
		propsRef.current.onSearch(query);
	}, 150);

	function onCompositionStart() {
		isComposingRef.current = true;
	}

	function onCompositionEnd(event: CompositionEvent<HTMLInputElement>) {
		isComposingRef.current = false;
		const value = event.currentTarget.value;
		setHasQuery(value.length > 0);
		propsRef.current.onSearchQueryChange(value);
		debouncedSearch(value);
	}

	function onKeyDown(event: KeyboardEvent) {
		event.stopPropagation();

		if (event.key === "Enter") {
			if (event.nativeEvent.isComposing) {
				return;
			}
			event.preventDefault();
			if (event.shiftKey) {
				propsRef.current.onNavigateToPrevMatch();
			} else {
				propsRef.current.onNavigateToNextMatch();
			}
		}
	}

	function onChange(event: ChangeEvent<HTMLInputElement>) {
		if (isComposingRef.current) {
			return;
		}
		const value = event.target.value;
		setHasQuery(value.length > 0);
		propsRef.current.onSearchQueryChange(value);
		debouncedSearch(value);
	}

	function onClose() {
		propsRef.current.onSearchOpenChange(false);
	}

	function onPrevMatch() {
		propsRef.current.onNavigateToPrevMatch();
	}

	function onNextMatch() {
		propsRef.current.onNavigateToNextMatch();
	}

	if (!searchOpen) {
		return null;
	}

	return (
		<div
			className="fade-in-0 slide-in-from-top-2 absolute end-4 top-4 z-50 flex animate-in flex-col gap-2 rounded-lg border bg-background p-2 shadow-lg"
			data-slot="grid-search"
			role="search"
		>
			<div className="flex items-center gap-2">
				<Input
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					className="h-8 w-64"
					defaultValue={searchQuery}
					onChange={onChange}
					onCompositionEnd={onCompositionEnd}
					onCompositionStart={onCompositionStart}
					onKeyDown={onKeyDown}
					placeholder="Find in table..."
					ref={inputRef}
					spellCheck={false}
				/>
				<div className="flex items-center gap-1">
					<Button
						aria-label="Previous match"
						className="size-7"
						disabled={searchMatches.length === 0}
						onClick={onPrevMatch}
						onPointerDown={onTriggerPointerDown}
						size="icon"
						variant="ghost"
					>
						<ChevronUp />
					</Button>
					<Button
						aria-label="Next match"
						className="size-7"
						disabled={searchMatches.length === 0}
						onClick={onNextMatch}
						onPointerDown={onTriggerPointerDown}
						size="icon"
						variant="ghost"
					>
						<ChevronDown />
					</Button>
					<Button
						aria-label="Close search"
						className="size-7"
						onClick={onClose}
						size="icon"
						variant="ghost"
					>
						<X />
					</Button>
				</div>
			</div>
			<div className="flex items-center gap-1 whitespace-nowrap text-muted-foreground text-xs">
				{searchMatches.length > 0 ? (
					<span>
						{matchIndex + 1} of {searchMatches.length}
					</span>
				) : hasQuery ? (
					<span>No results</span>
				) : (
					<span>Type to search</span>
				)}
			</div>
		</div>
	);
}

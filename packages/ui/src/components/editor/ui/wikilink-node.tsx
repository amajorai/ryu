"use client";

import {
	type DocLinkItem,
	getDocLinkProvider,
} from "@ryu/ui/lib/editor-doc-links.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TComboboxInputElement, TElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, useFocused, useSelected } from "platejs/react";
import { useEffect, useState } from "react";

import {
	InlineCombobox,
	InlineComboboxContent,
	InlineComboboxEmpty,
	InlineComboboxGroup,
	InlineComboboxInput,
	InlineComboboxItem,
} from "./inline-combobox.tsx";

/** Node type for a resolved-or-pending wiki link (`[[Title]]`). */
export const WIKILINK_KEY = "wikilink";
/** Node type for the transient `[[` combobox input. */
export const WIKILINK_INPUT_KEY = "wikilink_input";

type WikiLinkNode = TElement & { value?: string };

/**
 * A `[[Title]]` wiki link. Renders as a chip that navigates to the linked
 * document on click. When the title resolves to no existing document it renders
 * as pending (dimmed, dashed underline) and clicking creates the page first
 * (Obsidian's "create on click"). Resolution is delegated to the host-registered
 * {@link getDocLinkProvider}, so the editor stays Core-agnostic.
 */
export function WikiLinkElement(props: PlateElementProps<WikiLinkNode>) {
	const { element } = props;
	const selected = useSelected();
	const focused = useFocused();
	const title = String(element.value ?? "");
	const resolved = getDocLinkProvider().resolveByTitle(title);
	const pending = !resolved;

	const open = () => {
		const provider = getDocLinkProvider();
		if (resolved) {
			provider.openDoc(resolved.id);
			return;
		}
		provider
			.createPage(title)
			.then((doc) => {
				if (doc.id) {
					provider.openDoc(doc.id);
				}
			})
			.catch(() => {
				// swallow — creation failures leave the link pending.
			});
	};

	return (
		<PlateElement
			{...props}
			attributes={{
				...props.attributes,
				contentEditable: false,
				"data-slate-value": title,
				draggable: true,
			}}
			className={cn(
				"inline align-baseline font-medium text-sm",
				selected && focused && "rounded-md ring-2 ring-ring"
			)}
		>
			<span
				className={cn(
					"cursor-pointer rounded-md px-1",
					pending
						? "bg-muted/50 text-muted-foreground underline decoration-dashed"
						: "bg-primary/10 text-primary hover:bg-primary/20"
				)}
				onClick={open}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						open();
					}
				}}
				role="link"
				tabIndex={0}
			>
				{title}
			</span>
			{props.children}
		</PlateElement>
	);
}

/** The `[[` combobox: searches the active Space's documents and inserts a link. */
export function WikiLinkInputElement(
	props: PlateElementProps<TComboboxInputElement>
) {
	const { editor, element } = props;
	const [search, setSearch] = useState("");
	const [items, setItems] = useState<DocLinkItem[]>([]);

	useEffect(() => {
		let active = true;
		getDocLinkProvider()
			.search(search)
			.then((results) => {
				if (active) {
					setItems(results);
				}
			})
			.catch(() => {
				if (active) {
					setItems([]);
				}
			});
		return () => {
			active = false;
		};
	}, [search]);

	const insertWiki = (title: string) => {
		editor.tf.insertNodes({
			children: [{ text: "" }],
			type: WIKILINK_KEY,
			value: title,
		});
		editor.tf.move({ unit: "offset" });
	};

	const query = search.trim();
	const hasExact = items.some(
		(item) => item.title.toLowerCase() === query.toLowerCase()
	);

	return (
		<PlateElement {...props} as="span">
			<InlineCombobox
				element={element}
				filter={false}
				setValue={setSearch}
				showTrigger={false}
				trigger="[["
				value={search}
			>
				<span className="inline-block rounded-md bg-muted px-1.5 py-0.5 align-baseline text-sm ring-ring focus-within:ring-2">
					<InlineComboboxInput />
				</span>

				<InlineComboboxContent className="my-1.5">
					<InlineComboboxEmpty>No pages</InlineComboboxEmpty>

					<InlineComboboxGroup>
						{items.map((item) => (
							<InlineComboboxItem
								key={item.id || item.title}
								onClick={() => insertWiki(item.title)}
								value={item.title}
							>
								{item.title}
							</InlineComboboxItem>
						))}
						{query && !hasExact ? (
							<InlineComboboxItem
								key="__new_page"
								onClick={() => insertWiki(query)}
								value={query}
							>
								{`Create "${query}"`}
							</InlineComboboxItem>
						) : null}
					</InlineComboboxGroup>
				</InlineComboboxContent>
			</InlineCombobox>

			{props.children}
		</PlateElement>
	);
}

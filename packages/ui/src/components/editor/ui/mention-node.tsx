"use client";

import { getMentionOnSelectItem } from "@platejs/mention";
import { useMounted } from "@ryu/ui/hooks/use-mounted.ts";
import {
	type DocLinkItem,
	getDocLinkProvider,
} from "@ryu/ui/lib/editor-doc-links.ts";
import { inlineSuggestionVariants } from "@ryu/ui/lib/suggestion.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TComboboxInputElement, TMentionElement } from "platejs";
import { IS_APPLE, KEYS } from "platejs";
import type { PlateElementProps } from "platejs/react";
import {
	PlateElement,
	useFocused,
	useReadOnly,
	useSelected,
} from "platejs/react";
import { useEffect, useState } from "react";

import {
	InlineCombobox,
	InlineComboboxContent,
	InlineComboboxEmpty,
	InlineComboboxGroup,
	InlineComboboxInput,
	InlineComboboxItem,
} from "./inline-combobox.tsx";

export function MentionElement(
	props: PlateElementProps<TMentionElement> & {
		prefix?: string;
	}
) {
	const { element } = props;
	const selected = useSelected();
	const focused = useFocused();
	const mounted = useMounted();
	const readOnly = useReadOnly();

	// A mention links to a document by title (its `value`). Clicking navigates to
	// the resolved document, or creates it when the target does not exist yet.
	const openMention = () => {
		const provider = getDocLinkProvider();
		const title = String(element.value ?? "");
		const resolved = provider.resolveByTitle(title);
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
				// swallow — leave unresolved.
			});
	};

	const label = (
		<span
			className={cn(!readOnly && "cursor-pointer")}
			onClick={openMention}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					openMention();
				}
			}}
			role="link"
			tabIndex={0}
		>
			{props.prefix}
			{element.value}
		</span>
	);

	return (
		<PlateElement
			{...props}
			attributes={{
				...props.attributes,
				contentEditable: false,
				"data-slate-value": element.value,
				draggable: true,
			}}
			className={cn(
				"inline-block rounded-md bg-muted px-1.5 py-0.5 align-baseline font-medium text-sm",
				inlineSuggestionVariants(),
				!readOnly && "cursor-pointer",
				selected && focused && "ring-2 ring-ring",
				element.children[0][KEYS.bold] === true && "font-bold",
				element.children[0][KEYS.italic] === true && "italic",
				element.children[0][KEYS.underline] === true && "underline"
			)}
		>
			{mounted && IS_APPLE ? (
				// Mac OS IME https://github.com/ianstormtaylor/slate/issues/3490
				<>
					{props.children}
					{label}
				</>
			) : (
				// Others like Android https://github.com/ianstormtaylor/slate/pull/5360
				<>
					{label}
					{props.children}
				</>
			)}
		</PlateElement>
	);
}

// value/key are both the document *title* so the mention serializes to
// `[Title](mention:Title)` and resolves by title on the Core side.
const onSelectItem = getMentionOnSelectItem();

export function MentionInputElement(
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
				trigger="@"
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
								onClick={() =>
									onSelectItem(
										editor,
										{ key: item.title, text: item.title },
										search
									)
								}
								value={item.title}
							>
								{item.title}
							</InlineComboboxItem>
						))}
						{query && !hasExact ? (
							<InlineComboboxItem
								key="__new_page"
								onClick={() =>
									onSelectItem(editor, { key: query, text: query }, search)
								}
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

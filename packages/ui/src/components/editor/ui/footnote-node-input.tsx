"use client";

import { FootnoteReferencePlugin } from "@platejs/footnote/react";
import {
	InlineCombobox,
	InlineComboboxContent,
	InlineComboboxEmpty,
	InlineComboboxGroup,
	InlineComboboxInput,
	InlineComboboxItem,
} from "@ryu/ui/components/editor/ui/inline-combobox.tsx";
import type { PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";
import { useCallback, useState } from "react";

const NUMERIC_FOOTNOTE_QUERY = /^\d+$/;

const getFootnotePreviewLabel = (text?: string) => {
	const normalized = text?.replace(/\s+/g, " ").trim();

	if (!normalized) {
		return "Empty footnote";
	}

	return normalized.length > 48
		? `${normalized.slice(0, 45).trimEnd()}...`
		: normalized;
};

export function FootnoteInputElement(props: PlateElementProps) {
	const { editor, element } = props;
	const [search, setSearch] = useState("");
	const footnoteApi = editor.getApi(FootnoteReferencePlugin).footnote;
	const insertTransforms = editor.getTransforms(FootnoteReferencePlugin).insert;

	const identifiers = footnoteApi.identifiers?.() ?? [];
	const nextIdentifier = footnoteApi.nextId?.() ?? "1";
	const query = search.trim();
	const numericQuery = NUMERIC_FOOTNOTE_QUERY.test(query) ? query : "";
	const proposedIdentifier = numericQuery || nextIdentifier;
	const showCreateOption = !identifiers.includes(proposedIdentifier);

	const filteredIdentifiers = identifiers.filter((identifier: string) => {
		if (!query) {
			return true;
		}

		const preview = footnoteApi.definitionText?.({ identifier }) ?? "";

		return (
			identifier.includes(query) ||
			preview.toLowerCase().includes(query.toLowerCase())
		);
	});

	const insertSelectedFootnote = useCallback(
		(identifier: string) => {
			const before = editor.selection && editor.api.before(editor.selection);

			if (before) {
				const range = editor.api.range(before, editor.selection);

				if (range && editor.api.string(range) === "[") {
					editor.tf.deleteBackward("character");
				}
			}

			insertTransforms.footnote({
				focusDefinition: false,
				identifier,
			});
		},
		[editor, insertTransforms]
	);

	return (
		<PlateElement {...props} as="span">
			<InlineCombobox
				element={element}
				filter={false}
				setValue={setSearch}
				trigger="^"
				value={search}
			>
				<InlineComboboxInput className="min-w-[1ch]" />

				<InlineComboboxContent className="my-1.5 w-72">
					{showCreateOption || filteredIdentifiers.length > 0 ? null : (
						<InlineComboboxEmpty>No footnotes</InlineComboboxEmpty>
					)}

					<InlineComboboxGroup>
						{showCreateOption && (!query || numericQuery) ? (
							<InlineComboboxItem
								onClick={() => insertSelectedFootnote(proposedIdentifier)}
								value={`new-${proposedIdentifier}`}
							>
								<span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
									<span className="font-mono text-muted-foreground">
										[^{proposedIdentifier}]
									</span>
									<span className="truncate">: New footnote…</span>
								</span>
							</InlineComboboxItem>
						) : null}

						{filteredIdentifiers.map((identifier: string) => (
							<InlineComboboxItem
								key={identifier}
								onClick={() => insertSelectedFootnote(identifier)}
								value={`footnote-${identifier}`}
							>
								<span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
									<span className="font-mono text-muted-foreground">
										[^{identifier}]
									</span>
									<span className="truncate">
										:{" "}
										{getFootnotePreviewLabel(
											footnoteApi.definitionText?.({ identifier })
										)}
									</span>
								</span>
							</InlineComboboxItem>
						))}
					</InlineComboboxGroup>
				</InlineComboboxContent>
			</InlineCombobox>

			{props.children}
		</PlateElement>
	);
}

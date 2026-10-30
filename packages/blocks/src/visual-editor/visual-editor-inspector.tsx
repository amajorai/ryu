import { Badge, Button } from "@ryu/blocks/companion/controls";
import { ROOT_NODE_ID, type VisualOperation } from "./core.ts";
import { attributeFields, STYLE_FIELDS } from "./visual-editor-config.ts";
import { InspectorField } from "./visual-editor-inspector-field.tsx";

export function VisualEditorInspector({
	apply,
	disabled,
	fieldKey,
	isLeaf,
	moveSelected,
	selected,
	selectedId,
	selectedStyle,
	selectedTag,
}: {
	apply: (operations: VisualOperation[], select?: string | null) => boolean;
	disabled: boolean;
	fieldKey: string;
	isLeaf: boolean;
	moveSelected: (delta: -1 | 1) => void;
	selected: Element | null;
	selectedId: string | null;
	selectedStyle: CSSStyleDeclaration | undefined;
	selectedTag: string;
}) {
	return (
		<section
			aria-label="Inspector"
			className="flex flex-col gap-2 rounded-lg border p-3"
		>
			{selected && selectedId ? (
				<>
					<div className="flex items-center justify-between gap-2">
						<h3 className="font-medium text-sm">Selected</h3>
						<Badge variant="outline">
							{selectedId === ROOT_NODE_ID ? "page" : `<${selectedTag}>`}
						</Badge>
					</div>
					{selectedId === ROOT_NODE_ID ? null : (
						<div className="flex flex-wrap gap-1">
							<Button
								disabled={disabled}
								onClick={() => moveSelected(-1)}
								size="sm"
								variant="outline"
							>
								Move up
							</Button>
							<Button
								disabled={disabled}
								onClick={() => moveSelected(1)}
								size="sm"
								variant="outline"
							>
								Move down
							</Button>
							<Button
								disabled={disabled}
								onClick={() =>
									apply([{ kind: "duplicate", nodeId: selectedId }])
								}
								size="sm"
								variant="outline"
							>
								Duplicate
							</Button>
							<Button
								disabled={disabled}
								onClick={() =>
									apply([{ kind: "remove", nodeId: selectedId }], null)
								}
								size="sm"
								variant="outline"
							>
								Delete
							</Button>
						</div>
					)}
					{isLeaf ? (
						<InspectorField
							defaultValue={selected.textContent ?? ""}
							disabled={disabled}
							key={`text:${fieldKey}`}
							label="Text"
							multiline
							onCommit={(text) =>
								apply(
									[{ kind: "setText", nodeId: selectedId, text }],
									selectedId
								)
							}
						/>
					) : null}
					{attributeFields(selectedTag).map(([name, label]) => (
						<InspectorField
							defaultValue={selected.getAttribute(name) ?? ""}
							disabled={disabled}
							key={`${name}:${fieldKey}`}
							label={label}
							onCommit={(value) =>
								apply(
									[
										{
											kind: "setAttribute",
											nodeId: selectedId,
											name,
											value: value || null,
										},
									],
									selectedId
								)
							}
						/>
					))}
					<details>
						<summary className="cursor-pointer text-sm">Style</summary>
						<div className="mt-2 flex flex-col gap-2">
							{STYLE_FIELDS.map(([property, label]) => (
								<InspectorField
									defaultValue={selectedStyle?.getPropertyValue(property) ?? ""}
									disabled={disabled}
									key={`${property}:${fieldKey}`}
									label={label}
									onCommit={(value) =>
										apply(
											[
												{
													kind: "setStyle",
													nodeId: selectedId,
													property,
													value: value || null,
												},
											],
											selectedId
										)
									}
								/>
							))}
						</div>
					</details>
				</>
			) : (
				<p className="text-muted-foreground text-sm">
					Select something on the page to edit it.
				</p>
			)}
		</section>
	);
}

"use client";

import { formatCodeBlock, isLangSupported } from "@platejs/code-block";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/editor/ui/command.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { BracesIcon, Check, CheckIcon, CopyIcon } from "lucide-react";
import { NodeApi, type TCodeBlockElement, type TCodeSyntaxLeaf } from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	PlateLeaf,
	type PlateLeafProps,
	useEditorRef,
	useElement,
	useReadOnly,
} from "platejs/react";
import { type ComponentProps, useEffect, useMemo, useState } from "react";
import { isNativeFunction } from "../../../lib/native-primitive-observation.ts";
import {
	codeBlockLanguages,
	codeBlockLanguageText,
	getCodeBlockLanguageLabel,
} from "./code-block-languages.tsx";

type CodeBlockElementProps = PlateElementProps<TCodeBlockElement> & {
	showLanguageLabel?: boolean;
};

export function CodeBlockElement({
	showLanguageLabel = true,
	...props
}: CodeBlockElementProps) {
	const { editor, element } = props;
	const tl = useLiteralMessages();

	return (
		<PlateElement
			className="py-1 **:[.hljs-addition]:bg-[#f0fff4] **:[.hljs-addition]:text-[#22863a] dark:**:[.hljs-addition]:bg-[#3c5743] dark:**:[.hljs-addition]:text-[#ceead5] **:[.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable]:text-[#005cc5] dark:**:[.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable]:text-[#6596cf] **:[.hljs-built\\\\_in,.hljs-symbol]:text-[#e36209] dark:**:[.hljs-built\\\\_in,.hljs-symbol]:text-[#c3854e] **:[.hljs-bullet]:text-[#735c0f] **:[.hljs-comment,.hljs-code,.hljs-formula]:text-[#6a737d] dark:**:[.hljs-comment,.hljs-code,.hljs-formula]:text-[#6a737d] **:[.hljs-deletion]:bg-[#ffeef0] **:[.hljs-deletion]:text-[#b31d28] dark:**:[.hljs-deletion]:bg-[#473235] dark:**:[.hljs-deletion]:text-[#e7c7cb] **:[.hljs-emphasis]:italic **:[.hljs-keyword,.hljs-doctag,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language\\\\_]:text-[#d73a49] dark:**:[.hljs-keyword,.hljs-doctag,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language\\\\_]:text-[#ee6960] **:[.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo]:text-[#22863a] dark:**:[.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo]:text-[#36a84f] **:[.hljs-regexp,.hljs-string,.hljs-meta_.hljs-string]:text-[#032f62] dark:**:[.hljs-regexp,.hljs-string,.hljs-meta_.hljs-string]:text-[#3593ff] **:[.hljs-section]:font-medium **:[.hljs-section]:text-[#005cc5] dark:**:[.hljs-section]:text-[#61a5f2] **:[.hljs-strong]:font-medium **:[.hljs-title,.hljs-title.class\\\\_,.hljs-title.class\\\\_.inherited\\\\_\\\\_,.hljs-title.function\\\\_]:text-[#6f42c1] dark:**:[.hljs-title,.hljs-title.class\\\\_,.hljs-title.class\\\\_.inherited\\\\_\\\\_,.hljs-title.function\\\\_]:text-[#a77bfa]"
			{...props}
		>
			<div className="relative rounded-md bg-muted/50">
				<pre
					className="overflow-x-auto p-8 pe-4 text-start font-mono text-sm leading-[normal] [tab-size:2] print:break-inside-avoid"
					dir="ltr"
				>
					<code>{props.children}</code>
				</pre>

				<div
					className="absolute end-1 top-1 z-10 flex select-none gap-0.5"
					contentEditable={false}
				>
					{isLangSupported(element.lang) && (
						<Button
							className="size-6 text-xs"
							onClick={() => formatCodeBlock(editor, { element })}
							size="icon"
							title={tl("Format code")}
							variant="ghost"
						>
							<BracesIcon className="!size-3.5 text-muted-foreground" />
						</Button>
					)}

					<CodeBlockCombobox showLanguageLabel={showLanguageLabel} />

					<CopyButton
						className="size-6 gap-1 text-muted-foreground text-xs"
						size="icon"
						value={() => NodeApi.string(element)}
						variant="ghost"
					/>
				</div>
			</div>
		</PlateElement>
	);
}

function CodeBlockCombobox({
	showLanguageLabel,
}: {
	showLanguageLabel: boolean;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const readOnly = useReadOnly();
	const editor = useEditorRef();
	const element = useElement<TCodeBlockElement>();
	const value = element.lang || "plaintext";
	const [searchValue, setSearchValue] = useState("");

	const items = useMemo(
		() =>
			codeBlockLanguages.filter(
				(language) =>
					!searchValue ||
					language.label.toLowerCase().includes(searchValue.toLowerCase())
			),
		[searchValue]
	);

	if (readOnly) {
		if (!showLanguageLabel) {
			return null;
		}

		return <CodeBlockLanguageLabel lang={element.lang} />;
	}

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-expanded={open}
						className="h-6 select-none justify-between gap-1 px-2 text-muted-foreground text-xs"
						role="combobox"
						size="sm"
						variant="ghost"
					/>
				}
			>
				{localizedLanguageLabel(value, tl)}
			</PopoverTrigger>
			<PopoverContent
				className="w-[200px] p-0"
				onCloseAutoFocus={() => setSearchValue("")}
			>
				<Command shouldFilter={false}>
					<CommandInput
						className="h-9"
						onValueChange={(value) => setSearchValue(value)}
						placeholder="Search language…"
						value={searchValue}
					/>
					<CommandEmpty>No language found.</CommandEmpty>

					<CommandList className="h-[344px] overflow-y-auto">
						<CommandGroup>
							{items.map((language) => (
								<CommandItem
									className="cursor-pointer"
									key={language.label}
									onSelect={(value) => {
										editor.tf.setNodes<TCodeBlockElement>(
											{ lang: value },
											{ at: element }
										);
										setSearchValue(value);
										setOpen(false);
									}}
									value={language.value}
								>
									<Check
										className={cn(
											value === language.value ? "opacity-100" : "opacity-0"
										)}
									/>
									{codeBlockLanguageText(language, tl)}
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The language trigger's text. The trigger stays inside the editable, which
 * the DOM localizer skips, so the two worded choices are literal tl() calls;
 * language names stay as written.
 */
function localizedLanguageLabel(lang: string, tl: LiteralMessage) {
	switch (lang.trim()) {
		case "auto":
			return tl("Auto");
		case "plaintext":
			return tl("Plain Text");
		default: {
			const label = getCodeBlockLanguageLabel(lang);
			return label ? (
				<span data-ryu-i18n="off">{label}</span>
			) : (
				tl("Plain Text")
			);
		}
	}
}

function CodeBlockLanguageLabel({ lang }: { lang?: string | null }) {
	const tl = useLiteralMessages();
	const label = getCodeBlockLanguageLabel(lang);

	if (!(lang && label)) {
		return null;
	}

	return (
		<span className="flex h-6 select-none items-center px-2 text-muted-foreground text-xs">
			{codeBlockLanguageText({ label, value: lang }, tl)}
		</span>
	);
}

function CopyButton({
	value,
	...props
}: { value: (() => string) | string } & Omit<
	ComponentProps<typeof Button>,
	"value"
>) {
	const [hasCopied, setHasCopied] = useState(false);
	const tl = useLiteralMessages();

	useEffect(() => {
		setTimeout(() => {
			setHasCopied(false);
		}, 2000);
	}, []);

	return (
		<Button
			onClick={() => {
				Promise.resolve(
					navigator.clipboard.writeText(
						isNativeFunction(value) ? value() : value
					)
				).catch(() => undefined);
				setHasCopied(true);
			}}
			{...props}
		>
			<span className="sr-only">{tl("Copy")}</span>
			{hasCopied ? (
				<CheckIcon className="!size-3" />
			) : (
				<CopyIcon className="!size-3" />
			)}
		</Button>
	);
}

export function CodeLineElement(props: PlateElementProps) {
	return <PlateElement {...props} />;
}

export function CodeSyntaxLeaf(props: PlateLeafProps<TCodeSyntaxLeaf>) {
	const tokenClassName = props.leaf.className;

	return <PlateLeaf className={tokenClassName} {...props} />;
}

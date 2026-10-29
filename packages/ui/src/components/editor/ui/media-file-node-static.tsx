import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { FileUp } from "lucide-react";
import type { TFileElement, TSuggestionData } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

export function FileElementStatic(props: SlateElementProps<TFileElement>) {
	const { name, url } = props.element;
	const safeUrl = safeMediaUrl(url);
	// SAFETY: This renderer forwards Plate suggestion metadata attached by its native Suggestion plugin; the optional native field is read without reconstructing the element.
	// SAFETY: This renderer forwards Plate suggestion metadata attached by its native Suggestion plugin; the optional native field is read without reconstructing the element.
	const suggestionData = (
		props.element as TFileElement & {
			suggestion?: TSuggestionData;
		}
	).suggestion;
	const isRemoveSuggestion = suggestionData?.type === "remove";

	return (
		<SlateElement className="my-px rounded-sm" {...props}>
			<a
				className={cn(
					"group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-[3px] hover:bg-muted",
					isRemoveSuggestion &&
						"bg-destructive/10 text-status-destructive hover:bg-destructive/20"
				)}
				contentEditable={false}
				download={name}
				href={safeUrl ?? undefined}
				rel="noopener noreferrer"
				role="button"
				target="_blank"
			>
				<div
					className={cn(
						"flex items-center gap-1 p-1",
						isRemoveSuggestion && "line-through decoration-current"
					)}
				>
					<FileUp className="size-5" />
					<div>{name}</div>
				</div>
			</a>
			{props.children}
		</SlateElement>
	);
}

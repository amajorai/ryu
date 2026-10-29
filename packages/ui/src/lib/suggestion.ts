import { cva } from "class-variance-authority";

export const inlineSuggestionVariants = cva(
	"in-data-[inline-suggestion=insert]:bg-suggestion-insert-surface! in-data-[inline-suggestion=remove]:bg-suggestion-remove-surface! in-data-[inline-suggestion=insert]:text-suggestion-insert-foreground! in-data-[inline-suggestion=remove]:text-suggestion-remove-foreground! data-[inline-suggestion=insert]:bg-suggestion-insert-surface! data-[inline-suggestion=remove]:bg-suggestion-remove-surface! data-[inline-suggestion=insert]:text-suggestion-insert-foreground! data-[inline-suggestion=remove]:text-suggestion-remove-foreground!"
);

import {
	InlineErrorRow,
	type InlineErrorRowProps,
} from "@/src/components/chat/InlineErrorRow.tsx";

/**
 * `InlineErrorRow` for a message the reader has to see in full, such as a
 * validation sentence or the server's reason a save failed. It wraps instead of
 * truncating to one line. Use the plain row for fixed one-line sentences.
 */
export function ErrorLine(props: Omit<InlineErrorRowProps, "wrap">) {
	return <InlineErrorRow {...props} wrap />;
}

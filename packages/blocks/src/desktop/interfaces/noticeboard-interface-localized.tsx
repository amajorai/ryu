import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { NoticeboardInterface } from "./noticeboard-interface.tsx";
import { useLocalizedSnapshot } from "./use-localized-snapshot.ts";

/**
 * The noticeboard, re-keyed on the UI language. Its area labels and header
 * summary are cached per snapshot, so this hands it a fresh snapshot identity
 * when the catalog loads or the language changes; the board re-renders in
 * place and keeps its positions, drag and composer state.
 */
export function LocalizedNoticeboardInterface(
	props: InterfaceRendererProps<InterfaceParamsByRenderer["noticeboard"]>
) {
	const snapshot = useLocalizedSnapshot(props.snapshot);
	return <NoticeboardInterface {...props} snapshot={snapshot} />;
}

// Capability adapter for `browser.control / browser.snapshot` backed by browser-use.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// browser-use acts on its active tab and reports some failures as plain text
// ("Error: ..." or "Element with index N not found") without isError, so both
// shapes count as failure here rather than being passed on as success.
//
// browser_get_state lists interactive elements by integer index. The canonical
// verb promises @eN references, so each index is surfaced as "@e<index>" and the
// click/type adapters parse it back.

const textOf = (result) => result?.content?.find((item) => item?.type === "text")?.text ?? "";
const failed = (result) =>
	!result ||
	result.isError === true ||
	Boolean(result.error) ||
	result.available === false ||
	/^(Error:|Element with index )/.test(textOf(result));

// Honour the canonical tab_id by switching first instead of acting on whichever
// tab happens to be active. browser.tabs returns browser-use's own tab ids.
if (typeof input.tab_id === "string" && input.tab_id.trim()) {
	const switched = await callNamed("browseruse.browser_switch_tab", { tab_id: input.tab_id.trim() });
	if (failed(switched)) {
		return switched;
	}
}
const raw = await callTool({});
if (failed(raw)) {
	return { raw };
}
let state;
try {
	state = JSON.parse(textOf(raw));
} catch {
	return { raw };
}
if (!state || typeof state !== "object") {
	return { raw };
}
const elements = [];
for (const element of Array.isArray(state.interactive_elements) ? state.interactive_elements : []) {
	if (!Number.isInteger(element?.index)) {
		continue;
	}
	elements.push({ ...element, ref: `@e${element.index}` });
}
return {
	tab_id: typeof input.tab_id === "string" ? input.tab_id.trim() : undefined,
	url: state.url,
	title: state.title,
	elements,
	viewport: state.viewport,
	scroll: state.scroll,
};

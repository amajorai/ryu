// Capability adapter for `browser.control / browser.tabs` backed by browser-use.
// Injected globals: `input`, `defaults`, `callTool`, and `callNamed`.
// This flat fragment runs inside Core's generated async adapter IIFE.
//
// browser-use acts on its active tab and reports some failures as plain text
// ("Error: ..." or "Element with index N not found") without isError, so both
// shapes count as failure here rather than being passed on as success.

const textOf = (result) => result?.content?.find((item) => item?.type === "text")?.text ?? "";
const failed = (result) =>
	!result ||
	result.isError === true ||
	Boolean(result.error) ||
	result.available === false ||
	/^(Error:|Element with index )/.test(textOf(result));
const raw = await callTool({});
if (failed(raw)) {
	return { raw };
}
let tabs;
try {
	tabs = JSON.parse(textOf(raw));
} catch {
	return { raw };
}
if (!Array.isArray(tabs)) {
	return { raw };
}
return {
	tabs: tabs
		.filter((tab) => typeof tab?.tab_id === "string")
		.map((tab) => ({ id: tab.tab_id, url: tab.url ?? "", title: tab.title ?? "" })),
};

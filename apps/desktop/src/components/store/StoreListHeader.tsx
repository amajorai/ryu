// Moved into @ryu/marketplace so desktop and web share one implementation. This
// re-export keeps the desktop-local catalog sections' import path stable. The
// shared header reads the section-tab chrome via a non-throwing context accessor,
// so desktop (provider mounted) renders the tab row exactly as before.
export { default } from "@ryu/marketplace/catalog/chrome/store-list-header";

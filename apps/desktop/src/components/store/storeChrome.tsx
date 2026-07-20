// Moved into @ryu/marketplace so desktop and web share one implementation. This
// re-export keeps the desktop-local import path stable. `StoreSectionTab` is now
// declared in the package (structurally identical to the old blocks type).
export {
	StoreChromeProvider,
	type StoreChromeValue,
	type StoreSectionTab,
	useStoreChrome,
	useStoreChromeOptional,
} from "@ryu/marketplace/catalog/chrome/store-chrome";

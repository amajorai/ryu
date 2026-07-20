// The catalog badge primitives moved into @ryu/marketplace so desktop and web
// render them from one implementation. Desktop's Models + Skills sections import
// them from here unchanged; this re-export keeps those import paths stable and the
// behavior byte-equivalent. (The Models section still sources its model-display
// helpers from `@/src/lib/catalog/friendly.ts`; the Models decomposition follow-on
// consolidates that copy into the package too.)
export * from "@ryu/marketplace/catalog/chrome/catalog-badges";

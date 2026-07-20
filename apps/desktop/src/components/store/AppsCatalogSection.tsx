// The Plugins catalog section moved into @ryu/marketplace so desktop and web
// render it from one implementation. Desktop mounts the DesktopCatalogHost
// (StorePage) which injects the Core-node apps hook + install layer; this
// re-export keeps StorePage's import path stable and behavior byte-equivalent.
export { default } from "@ryu/marketplace/catalog/apps";

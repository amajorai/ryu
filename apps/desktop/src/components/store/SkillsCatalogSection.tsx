// The Skills catalog section moved into @ryu/marketplace so desktop and web render
// it from one implementation. Desktop mounts the DesktopCatalogHost (StorePage)
// which injects the Core-node skills hook + install layer + `navigate` (the
// SKILL.md authoring deep-links); this re-export keeps StorePage's import path
// stable and behavior byte-equivalent.
export { default } from "@ryu/marketplace/catalog/skills";

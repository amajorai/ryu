# Isometric figure kit

Vendored from [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy) at commit
`1482e84` under the MIT license (see `LICENSE` in this folder). It draws the interactive
isometric figures on the marketing pages. Keep local changes small and note them here so
the kit can be refreshed from upstream.

Local changes from upstream:

- `iso-kit.ts` starts with `// @ts-nocheck`, because upstream is not written for this
  repository's `noUncheckedIndexedAccess` setting. The rest of the file is unchanged.
- `react/draw.tsx` imports with explicit `.ts`/`.tsx` extensions.
- The folder is excluded from Biome in the root `biome.json`, like `dither-kit`.

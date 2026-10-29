# Vendored hero backgrounds

Third-party background effects used by `../hero-background.tsx`. They are copied
from their registries with only the changes listed here, so they can be refreshed
by copying again.

| Directory | Source | Licence |
| --- | --- | --- |
| `react-bits/` | [React Bits](https://reactbits.dev) registry, `https://reactbits.dev/r/<Name>-TS-TW.json` | MIT + Commons Clause (`react-bits/LICENSE`) |
| `spell/` | [Spell UI](https://spell.sh) registry, `https://spell.sh/r/<name>.json` | MIT (`spell/LICENSE`) |

Changes from upstream:

- Every file starts with a `// @ts-nocheck` line naming its source. The upstream
  code is not written for this repository's `noUncheckedIndexedAccess`; its
  exported prop types still type-check their callers.
- The React Bits WebGL components no longer call
  `WEBGL_lose_context.loseContext()` on unmount (the line is replaced by a
  `Ryu patch` comment). They render their `<canvas>` from JSX, so a remount
  (React Strict Mode, Fast Refresh) reuses the same canvas and got the lost
  context back, drawing nothing. ColorBends creates its own canvas per mount
  and keeps upstream's cleanup.
- `spell/animated-gradient.tsx` takes a `forceDark` prop that keeps the dark
  preset colours whatever the site theme, because product heroes are a dark
  stage in both themes.
- Every raw WebGL context is requested with `failIfMajorPerformanceCaveat:
  true` (marked `Ryu patch`), so a browser on software GL (SwiftShader, a
  blocklisted driver) gets no context and the effect draws nothing over the
  static stage. `HeroBackground` already mounts an effect only after the first
  idle period and only when a probe finds a hardware GPU (`../webgl-gate.ts`,
  `../use-backdrop-gate.ts`); the flag covers a GPU process that falls back to
  software after the probe. The three.js renderers (ColorBends, Spell UI light
  rays) do not take the flag, because three throws without a context.
- ColorBends and both Spell UI effects run their frame loop through
  `createFrameLoop` from `../webgl-gate.ts`: it pauses off screen and in hidden
  tabs, and under reduced motion draws one still frame (upstream looped every
  frame unconditionally). ColorBends and the animated gradient cap the pixel
  ratio with `backdropPixelRatio` (1.5x). The animated gradient and light rays
  drop `antialias`, light rays also drops `preserveDrawingBuffer` and clamps its
  per-frame clock step so a resume does not jump.

Not vendored, on purpose:

- Aceternity's shooting stars and stars background: its licence allows use in
  end products but not redistribution of the source, and `packages/blocks` is
  published in the source-available mirror. `../starfield.tsx` is Ryu's own.
- 23rd.dev's Radiant Lines: the project publishes no licence.
  `../radiant-lines.tsx` is Ryu's own.
- 21st.dev's "Adisyon" shader: its source requires a signed-in account. The
  Ryu Mail backdrop uses React Bits' Gradient Waves with the shader's published
  palette instead.

This directory is excluded from Biome (root `biome.json`) and exempt from the
file-size guard as vendored code.

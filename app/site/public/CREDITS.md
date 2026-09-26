# Credits

Every third-party asset shipped with the Payblame site, and every asset built for it. Code in this repo is MIT (see `LICENSE` at the repo root); the assets below keep their own licenses.

## Sourced

| asset | file | source | author | license |
|---|---|---|---|---|
| Monochrome Studio 02 (HDRI, 1k) | `tex/monochrome_studio_02_1k.hdr` | https://polyhaven.com/a/monochrome_studio_02 | Grzegorz Wronkowski | CC0 1.0 |
| Paper 001 (normal + roughness, 1K, re-encoded to webp) | `tex/paper001_normal.webp`, `tex/paper001_roughness.webp` | https://ambientcg.com/a/Paper001 | Lennart Demes (ambientCG) | CC0 1.0 |
| Draco decoder | `draco/draco_decoder.js`, `draco/draco_decoder.wasm`, `draco/draco_wasm_wrapper.js` | three.js `examples/jsm/libs/draco/` (Google Draco) | Google | Apache-2.0 |

## Fonts (vendored woff2, Latin subset from Google Fonts)

| face | file | source | author | license |
|---|---|---|---|---|
| Bitcount Grid Single (variable) | `fonts/bitcount-grid-single.woff2` | https://fonts.google.com/specimen/Bitcount+Grid+Single | Petr van Blokland | SIL Open Font License 1.1 |
| Atkinson Hyperlegible Next (variable) | `fonts/atkinson-hyperlegible-next.woff2` | https://fonts.google.com/specimen/Atkinson+Hyperlegible+Next | Braille Institute of America, Applied Design Works | SIL Open Font License 1.1 |
| Atkinson Hyperlegible Mono (variable) | `fonts/atkinson-hyperlegible-mono.woff2` | https://fonts.google.com/specimen/Atkinson+Hyperlegible+Mono | Braille Institute of America, Applied Design Works | SIL Open Font License 1.1 |

## Built for this project (original, no third-party geometry)

| asset | file | how |
|---|---|---|
| PB-10 print mechanism (the 3D object on the page) | built at runtime by `site/src/scene/printer.js` | Procedural three.js geometry, no model file. The printout on its paper is drawn from the live `/api/ledger` rows (masked). |
| payblame mark, extruded | `models/mark.glb` | The payblame mark (`mark.svg`) rebuilt as ten circles and extruded with ExtrudeGeometry, draco-compressed. Used for brand renders; the site itself does not load it. |
| payblame mark | `mark.svg`, `favicon.svg` | Ten dots in a P, one per shareholder slot. |
| social card | `og.png` | Rendered from the same three.js scene; ledger rows in it are masked (`github:####`). |

The studio's baked `pb10.glb` export (used only for brand renders) is not part of this repo: its paper texture printed account prefixes next to amounts.

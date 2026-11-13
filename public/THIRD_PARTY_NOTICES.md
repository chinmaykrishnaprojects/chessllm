# Third-party notices

No single license is asserted for all files in this project. The following
third-party components retain their own notices and terms. Names are used for
attribution; no endorsement is implied.

## Pretrained ChessGPT checkpoints and custom ONNX exports

Source: [Adam Karvonen's chess_llms model repository](https://huggingface.co/adamkarvonen/chess_llms),
revision `7d20ccc022c9f46698a1e7370ccf2c1a6392f6dd`.
Its [model card](licenses/chess-llms-MODEL_CARD.md) declares the MIT license.
The local base checkpoints were checked against the upstream Git LFS SHA-256
identifiers; the exact identities are listed in `MODEL_ASSETS.json` in the
source repository. The int8 ONNX stateless and optional KV exports are
conversions of those checkpoints, not upstream-hosted ONNX files. Their
SHA-256 hashes identify the distributed conversions.

The upstream model repository supplied a license identifier in its card but
no separate model LICENSE/copyright-notice file was located. This notice
preserves that declaration and source attribution without inventing a
copyright year or relicensing the checkpoints. The pinned model card is
included unchanged.

The unrelated `adamkarvonen/chess_gpt_eval` Python repository has no detected
license through GitHub's license endpoint. No MIT grant is inferred for it.
Its Python evaluation/training/backend code and history are not part of this
curated browser-source distribution.

## ONNX Runtime and browser libraries

| Component | Version inspected | Declared license | Included notice |
| --- | --- | --- | --- |
| ONNX Runtime Web / Common | 1.27.0 | MIT | [Microsoft license](licenses/onnxruntime-LICENSE.txt), [complete upstream third-party notices](licenses/onnxruntime-ThirdPartyNotices.txt) |
| React / React DOM | 19.2.1 | MIT | [React](licenses/react-LICENSE.txt), [React DOM](licenses/react-dom-LICENSE.txt) |
| React Scheduler | 0.27.0 | MIT | [Scheduler](licenses/scheduler-LICENSE.txt) |
| chess.js | 1.4.0 | BSD-2-Clause | [License](licenses/chess.js-LICENSE.txt) |
| chessboard2 | 0.5.0 | ISC | [License](licenses/chessboard2-LICENSE.txt) |
| FlatBuffers | 25.9.23 | Apache-2.0 | [License](licenses/flatbuffers-LICENSE.txt) |
| long | 5.3.2 | Apache-2.0 | [License](licenses/long-LICENSE.txt) |
| platform | 1.3.6 | MIT | [License](licenses/platform-LICENSE.txt) |
| protobuf.js and installed @protobufjs helpers | 7.6.5 / versions in package-lock.json | BSD-3-Clause | [Main license](licenses/protobufjs-LICENSE.txt); helper notices are included alongside it |
| guid-typescript | 1.0.9 | ISC in package metadata | [Original package metadata](licenses/guid-typescript-package.json); no standalone notice was supplied by this package |
| Vite development template/tooling | 7.2.7 | MIT with bundled notices | [License](licenses/vite-LICENSE.md) |

Dependency versions are pinned in `package-lock.json`. Runtime licenses and
notices are retained even when a package is tree-shaken out of a browser
bundle. ONNX Runtime's complete notices cover a wider set of optional runtime
components than the WASM execution path used by this website.

## Piece artwork

The embedded piece vectors are adaptations of the cburnett set by
**Colin M. L. Burnett**, distributed by Lichess under **GPL-2.0-or-later**.
The [Lichess copying notice](licenses/lila-COPYING.md) identifies that set and
author. [GPL version 2](licenses/GPL-2.0.txt) is included.

The editable vectors actually embedded by this application are available in
[licenses/pieces-source/](licenses/pieces-source/). They have been inlined and
adapted; they are not asserted to be byte-identical to Lichess's current SVG
revision. Original upstream artwork is available from
[Lichess's cburnett directory](https://github.com/lichess-org/lila/tree/master/public/piece/cburnett).
These artwork terms are not a blanket license assertion for unrelated code.

## Optional remote move/capture sounds

The original interface requests `Move.mp3` and `Capture.mp3` from Lichess's
`public/sound/standard` directory. These files are remotely served by the
upstream host, not vendored in this source snapshot. Lila's default license
is **AGPL-3.0-or-later** unless a documented exception applies; no separate
exception for these two paths was identified in the inspected copying list.
See the included [Lila copying notice](licenses/lila-COPYING.md),
[AGPL text](licenses/AGPL-3.0.txt), and
[upstream sound source](https://github.com/lichess-org/lila/tree/master/public/sound/standard).
No additional rights to these recordings are asserted by this project.

## Stockfish browser engine

The separately executed engine is **stockfish.js 10.0.2** from
[Niklas Fiekas / the Lichess stockfish.js project](https://github.com/lichess-org/stockfish.js),
derived from Stockfish and Daniel Dugovic's multi-variant fork. Its retained
header credits Tord Romstad, Marco Costalba, Joona Kiiski, Gary Linscott, and
other contributors; JavaScript compilation is credited to Niklas Fiekas.

It is distributed under **GNU GPL version 3**. The full license, unchanged
engine, complete corresponding-source snapshot and build instructions are
available together at [stockfish/SOURCE.md](stockfish/SOURCE.md).
This is the historical single-threaded asm.js build, not Stockfish 18 or a
newly compiled WebAssembly engine. No local engine modifications are claimed.

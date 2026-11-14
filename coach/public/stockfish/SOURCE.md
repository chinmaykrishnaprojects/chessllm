# Stockfish browser engine source and license

- Package: [stockfish.js 10.0.2](https://www.npmjs.com/package/stockfish.js/v/10.0.2).
- Engine: **Stockfish 2019-08-15 Multi-Variant**, single-threaded asm.js.
- Engine file: [stockfish.js](stockfish.js), 1,579,948 bytes.
- Engine SHA-256: `723fda70117bfa8d5053a7bc4ae50cdc96dc9e3fd41b57627e4dfa0a0025957a`.
- License: GNU GPL version 3; the original engine header is preserved.
  The full text is in [COPYING.txt](COPYING.txt).

Stockfish credits Tord Romstad, Marco Costalba, Joona Kiiski, Gary Linscott,
and contributors. Multi-variant support is by Daniel Dugovic and contributors.
Niklas Fiekas compiled the browser distribution using Emscripten and Binaryen.
No engine patches or local recompilation are claimed.

## Corresponding source

[Download the complete source archive](stockfish-source-e105072e84cf8ee5dd5219e2c5be29c3b8bf8a5a.tar.gz)
from this same directory. It is the upstream repository snapshot at
[`e105072e84cf8ee5dd5219e2c5be29c3b8bf8a5a`](https://github.com/lichess-org/stockfish.js/commit/e105072e84cf8ee5dd5219e2c5be29c3b8bf8a5a),
the source commit recorded by the npm release.

Archive size: 192,974 bytes. Archive SHA-256:
`c387792121aec4732a22d2c847e07fe1ab899e02e2f37b071b8c9af3fe3d15c1`.
The archive contains the C++ sources, headers, complete authors list, license,
JavaScript preamble, build scripts, Makefile, Dockerfile, package metadata and
tests. No submodules are declared.

The supplied engine was checked byte-for-byte against the published npm
package's engine. Corresponding source is pinned using the package's gitHead.
A reproducible local rebuild was not performed.

## Build the engine

The source commit documents Emscripten **1.38.41**. With the documented SDK
and `uglifyjs` available, the upstream entry point is:

```sh
./build.sh
```

Its asm.js build compiles with `COMP=emscripten ARCH=js`, prepends
`preamble.js`, and minifies the generated engine. See the archive's
`build.sh`, `Dockerfile`, and `Readme.md` for the complete commands.
Historical SDK/container references are not fully pinned; byte-identical
rebuilds are not asserted.

Keep the engine, license and corresponding source publicly available together.

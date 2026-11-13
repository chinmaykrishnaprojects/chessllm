# ChessLLM

[Website](https://chessllmweb.vercel.app)

A browser chess playground for character-level ChessGPT models. Play against
the Stockfish-trained or Lichess-trained model, inspect legal-move
probabilities, and compare positions with a separate Stockfish engine.

Model inference runs in a Web Worker using ONNX Runtime. Models download on
first use and are cached on the device. The native 32-character chess
vocabulary is retained; this project does not use a GPT-2 tokenizer.
Model probabilities describe the model's next-move distribution, not an
objective evaluation of move quality. Stockfish analysis is a separate engine.

The playground includes paired-color tournaments, PGN import/export, move
probability and timing records, an evaluation bar and a position-history graph.
Tournaments can pause and resume from a local checkpoint. Games stopped at a
ply limit are marked as adjudicated; they are not presented as played-out draws.
The bundled engine is the historical Stockfish.js 10.0.2 build.

Raw logits are cached separately from sampling settings, including a bounded
device cache that survives reloads. Turbo uses pruned scoring; switch it off
for exact legal-SAN scoring. The Activity toggle shows inference status.

## Run locally

Use Node.js 22 or newer.

```sh
npm ci
npm run dev
```

The four content-hashed ONNX files are included in `public/models`. Each is
about 51 MB; the browser downloads only the selected model. Downloads are
verified against the sizes and SHA-256 hashes in `public/models/manifest.json`.

```sh
npm test
npm run build
npm run preview -- --host 127.0.0.1 --port 8767
```

The site is a static Vite build; no backend, API credential or paid inference
service is required. Offline use requires one successful online visit and
download of the selected model. Browser storage can be cleared or evicted.
Only the model that is selected is downloaded to the browser.

## Models and credits

The pretrained checkpoints are by
[Adam Karvonen](https://huggingface.co/adamkarvonen/chess_llms). This project
uses custom int8 ONNX conversions, not newly trained base checkpoints.
`MODEL_ASSETS.json` identifies the upstream revision, checkpoint hashes,
conversion format, and exact distributed assets.

The application uses React, chess.js, ONNX Runtime, and a separate browser
Stockfish engine. Piece artwork is adapted from Colin M. L. Burnett's
cburnett set. See [third-party notices](public/THIRD_PARTY_NOTICES.md) for
credits, license texts, editable artwork, and Stockfish's corresponding source.

No repository-wide MIT license is claimed. Third-party materials retain their
respective licenses.

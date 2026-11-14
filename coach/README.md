# ChessLLM Coach

Paste one completed PGN, review critical positions, and ask Queen about the board.
Move analysis runs locally in a browser worker. Queen responses use the public
Hugging Face Space only after the user enables hosted analysis. Player names and
PGN comments are removed before sending the position and move history.

The position-pressure score compares the best and second-best engine lines. It
is a review-priority heuristic, not a calibrated probability of a human blunder
or a prediction of how much additional thinking time would help.

Queen's legal moves are checked. Its English explanations can contain errors;
they are shown separately from the local engine's candidate lines. The app does
not claim to reproduce the paper's rating or attest the remote Space's weights.

Model: [princeton-nlp/queen_pawn-8](https://huggingface.co/princeton-nlp/queen_pawn-8).
Hosted service: [hugging-apps/queen-pawn-8](https://huggingface.co/spaces/hugging-apps/queen-pawn-8).
Research: [Language Models that Play Chess and Explain Their Moves](https://arxiv.org/abs/2610.03695).
The model and hosted service are separate upstream projects; their component
terms apply. No Queen weights are redistributed in this repository.

Lichess import reads public, completed games through a bounded read-only proxy
on this site's Vercel deployment (20 games per request; no API credential).
The proxy keeps no game history. Pattern summaries use only supplied
evaluations, separate time controls and report sample sizes. Missing evaluations
are not replaced with guesses. Imported games remain in the browser unless the
user explicitly sends a position to hosted Queen.

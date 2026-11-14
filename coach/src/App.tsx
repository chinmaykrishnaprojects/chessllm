import { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { loadGame, PUBLIC_PGN, uciSan, type CoachGame } from './game'
import { askQueen, type QueenResult } from './queenTransport'
import { scanCriticalPositions, type CriticalPosition } from './leverage'
import { analyzeMultiPv, type MultiPvResult } from './multiPv'
import { formatEval, getStockfishEngine, type StockfishEval } from './lib/stockfishUci'
import { buildCoachPrompt } from './coachPrompt'
import { fetchLatestLichessGames, summarizeOpeningPatterns, LICHESS_SPEEDS, type LichessSpeed, type LichessImport, type ImportedLichessGame } from './lichess'

const START = new Chess().fen()
const PIECES: Record<string, string> = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' }
const NAMES: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }
type Turn = { question: string; result: QueenResult }
const NOTES = 'chessllm.coach.notes.v1'
function readNotes(): Record<string, string> {
  try { const value = JSON.parse(localStorage.getItem(NOTES) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([k, v]) => k.length < 200 && typeof v === 'string')) as Record<string, string> : {} } catch { return {} }
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
function label(game: CoachGame, ply: number) {
  const fields = game.fens[ply].split(' ')
  return `${fields[5]}${fields[1] === 'w' ? '.' : '…'} ${game.sans[ply] ?? 'position'}`
}
function safeSan(fen: string, moves: string[]) { try { return uciSan(fen, moves) } catch { return 'Variation unavailable' } }
function Board({ fen, flipped }: { fen: string; flipped: boolean }) {
  const chess = new Chess(fen)
  const files = flipped ? 'hgfedcba' : 'abcdefgh'
  const ranks = flipped ? '12345678' : '87654321'
  return <div className="board" role="img" aria-label={`Chess board, ${chess.turn() === 'w' ? 'White' : 'Black'} to move`}>
    {[...ranks].flatMap((rank, row) => [...files].map((file, col) => {
      const square = `${file}${rank}` as Parameters<Chess['get']>[0]
      const piece = chess.get(square)
      return <div key={square} className={`square ${(row + col) % 2 ? 'dark' : 'light'}`} title={`${square}: ${piece ? `${piece.color === 'w' ? 'White' : 'Black'} ${NAMES[piece.type]}` : 'empty'}`}>
        {col === 0 && <span className="rank">{rank}</span>}
        {piece && <span className={`piece ${piece.color}`} aria-hidden="true">{PIECES[piece.color + piece.type]}</span>}
        {row === 7 && <span className="file">{file}</span>}
      </div>
    }))}
  </div>
}

export default function App() {
  const [game, setGame] = useState<CoachGame>(() => loadGame('', START))
  const [pgn, setPgn] = useState('')
  const [fenInput, setFenInput] = useState('')
  const [ply, setPly] = useState(0)
  const [color, setColor] = useState('w')
  const [flipped, setFlipped] = useState(false)
  const [inputError, setInputError] = useState('')
  const [evalResult, setEvalResult] = useState<{ fen: string; value: StockfishEval }>()
  const [multi, setMulti] = useState<MultiPvResult>()
  const [engineBusy, setEngineBusy] = useState(false)
  const [engineError, setEngineError] = useState('')
  const [critical, setCritical] = useState<CriticalPosition[]>([])
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState([0, 0])
  const [scanError, setScanError] = useState('')
  const [consent, setConsent] = useState(false)
  const [question, setQuestion] = useState('What should I notice here, what is the plan, and what should I improve next time?')
  const [threads, setThreads] = useState<Record<string, Turn[]>>({})
  const [queenBusy, setQueenBusy] = useState(false)
  const [queenError, setQueenError] = useState('')
  const [notes, setNotes] = useState(readNotes)
  const [storageError, setStorageError] = useState('')
  const [username, setUsername] = useState('')
  const [speed, setSpeed] = useState<LichessSpeed>('bullet')
  const [lichess, setLichess] = useState<LichessImport>()
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState('')
  const importController = useRef<AbortController | null>(null)
  const queenController = useRef<AbortController | null>(null)
  const engineController = useRef<AbortController | null>(null)
  const scanController = useRef<AbortController | null>(null)
  const positionVersion = useRef(0)
  const gameVersion = useRef(0)
  const queenSequence = useRef(0)
  const fen = game.fens[ply]
  const board = new Chess(fen)
  const turns = threads[fen] ?? []
  function invalidate() {
    positionVersion.current++
    queenSequence.current++
    queenController.current?.abort(); engineController.current?.abort()
    setQueenBusy(false); setEngineBusy(false); setQueenError(''); setEngineError('')
  }
  function navigate(next: number) { invalidate(); setPly(Math.max(0, Math.min(game.sans.length, next))) }
  useEffect(() => () => { queenController.current?.abort(); engineController.current?.abort(); scanController.current?.abort(); importController.current?.abort() }, [])

  async function scan(loaded: CoachGame, version: number, reviewColor = color) {
    scanController.current?.abort()
    const controller = new AbortController(); scanController.current = controller
    setScanning(true); setScanError(''); setCritical([])
    try {
      const results = await scanCriticalPositions(loaded.fens.slice(0, -1), (done, total) => { if (gameVersion.current === version) setProgress([done, total]) }, controller.signal)
      if (controller.signal.aborted || gameVersion.current !== version) return
      setCritical(results)
      const pick = results.find(p => p.fen.split(' ')[1] === reviewColor) ?? results[0]
      if (pick) { invalidate(); setPly(pick.ply) }
    } catch (e) { if (!controller.signal.aborted && gameVersion.current === version) setScanError(message(e)) }
    finally { if (gameVersion.current === version) setScanning(false) }
  }
  function load(review: boolean, example = false) {
    try {
      const loaded = loadGame(example ? PUBLIC_PGN : pgn, example ? undefined : fenInput.trim() || undefined)
      invalidate(); scanController.current?.abort(); gameVersion.current++
      setScanning(false); setGame(loaded); setPly(loaded.sans.length); setCritical([]); setScanError(''); setInputError(''); setMulti(undefined); setEvalResult(undefined); setThreads({})
      if (example) { setPgn(PUBLIC_PGN); setFenInput('') }
      if (review && loaded.sans.length) void scan(loaded, gameVersion.current)
    } catch (e) { setInputError(message(e)) }
  }
  async function importRecent() {
    importController.current?.abort()
    const controller = new AbortController(); importController.current = controller
    setImportBusy(true); setImportError('')
    try {
      const value = await fetchLatestLichessGames(username, { speeds: [speed], maxPerSpeed: 20, signal: controller.signal, useProxy: true })
      if (!controller.signal.aborted) setLichess(value)
    } catch (e) { if (!controller.signal.aborted) setImportError(message(e)) }
    finally { if (importController.current === controller) setImportBusy(false) }
  }
  function selectImported(selected: ImportedLichessGame) {
    try {
      if (!selected.pgn) throw new Error('This export contains no PGN. Open the source game to export it.')
      const loaded = loadGame(selected.pgn)
      invalidate(); scanController.current?.abort(); gameVersion.current++
      const reviewColor = selected.playerColor === 'white' ? 'w' : 'b'
      setColor(reviewColor); setPgn(selected.pgn); setFenInput(''); setGame(loaded); setPly(loaded.sans.length)
      setCritical([]); setMulti(undefined); setEvalResult(undefined); setThreads({}); setInputError(''); setImportError('')
      void scan(loaded, gameVersion.current, reviewColor)
    } catch (e) { setImportError(message(e)) }
  }
  async function analyze() {
    engineController.current?.abort()
    const controller = new AbortController(); engineController.current = controller
    const version = positionVersion.current
    setEngineBusy(true); setEngineError('')
    try {
      const engine = await getStockfishEngine()
      const value = await engine.analyze(fen, 14, 700, controller.signal)
      if (controller.signal.aborted || version !== positionVersion.current) return
      setEvalResult({ fen, value })
      const lines = await analyzeMultiPv(fen, { count: 3, depth: 12, movetimeMs: 500, signal: controller.signal })
      if (!controller.signal.aborted && version === positionVersion.current) setMulti(lines)
    } catch (e) { if (!controller.signal.aborted && version === positionVersion.current) setEngineError(message(e)) }
    finally { if (version === positionVersion.current) setEngineBusy(false) }
  }
  async function ask() {
    if (!consent || queenBusy || !question.trim()) return
    const controller = new AbortController(); queenController.current = controller
    const version = positionVersion.current, sequence = ++queenSequence.current
    const asked = question.trim()
    const positionAnalysis = multi?.fen === fen ? multi : critical.find(p => p.fen === fen)?.analysis
    const prompt = buildCoachPrompt({ fen, question: asked, userColor: color as 'w' | 'b', playedSan: game.sans[ply], analysis: positionAnalysis, previous: turns.map(t => ({ question: t.question, answer: t.result.explanation })) })
    setQueenBusy(true); setQueenError('')
    try {
      const result = await askQueen({ fen, pgn: game.pgnAt(ply), question: prompt, allow_remote: true, max_new_tokens: 1024 }, controller.signal)
      if (controller.signal.aborted || positionVersion.current !== version || queenSequence.current !== sequence) return
      setThreads(old => ({ ...old, [fen]: [...(old[fen] ?? []), { question: asked, result }] }))
    } catch (e) { if (!controller.signal.aborted && version === positionVersion.current && sequence === queenSequence.current) setQueenError(message(e)) }
    finally { if (version === positionVersion.current && sequence === queenSequence.current) setQueenBusy(false) }
  }
  const filtered = critical.filter(p => p.fen.split(' ')[1] === color)
  const openingReport = lichess ? summarizeOpeningPatterns(lichess.games) : undefined
  const measured = evalResult?.fen === fen ? evalResult.value : undefined
  const lines = multi?.fen === fen ? multi : critical.find(p => p.fen === fen)?.analysis
  function saveNote(value: string) {
    const next = { ...notes, [fen]: value }; if (!value) delete next[fen]
    setNotes(next)
    try { localStorage.setItem(NOTES, JSON.stringify(next)); setStorageError('') } catch { setStorageError('Device storage unavailable; this note lasts only for this session.') }
  }

  return <div className="app">
    <header><a className="brand" href="/">♛ <span>ChessLLM <strong>Coach</strong></span></a><span className="local-badge">Local board · hosted Queen optional</span></header>
    <main>
      <section className="intro"><span className="eyebrow">YOUR NEXT MOVE STARTS WITH UNDERSTANDING</span><h1>Review a game.<br /><span>Find the moments that matter.</span></h1><p>Paste a PGN, revisit critical decisions, and ask Queen what to learn from them.</p></section>
      <section className="card import-card" aria-labelledby="import-title"><div className="section-heading"><h2 id="import-title">1. Bring your game</h2><button className="quiet" onClick={() => load(false, true)}>Try Scotch Gambit</button></div>
        <div className="import-grid"><label>PGN<textarea aria-label="PGN" value={pgn} onChange={e => setPgn(e.target.value)} maxLength={100000} placeholder="Paste one completed game's PGN, including clock tags if available." rows={4} spellCheck={false} /></label><div><label>FEN <span className="muted">optional, must match PGN end</span><textarea aria-label="FEN" value={fenInput} onChange={e => setFenInput(e.target.value)} maxLength={200} placeholder="Or paste a complete FEN to study one position." rows={2} spellCheck={false} /></label><label className="color-label">Review my decisions as <select aria-label="Review color" value={color} onChange={e => setColor(e.target.value)}><option value="w">White</option><option value="b">Black</option></select></label></div></div>
        <div className="actions"><button className="primary" onClick={() => load(true)}>Review game</button><button onClick={() => load(false)}>Load board only</button><span className="muted">Game import and engine review stay on this device.</span></div>{inputError && <p role="alert" className="error">{inputError}</p>}
      </section>
      <details className="card lichess-card"><summary>Or import recent public Lichess games</summary><p className="muted">Fetch up to 20 completed games for one speed. No login; no game is sent to Queen until you ask.</p><form className="actions" onSubmit={e => { e.preventDefault(); void importRecent() }}><label>Public username<input aria-label="Lichess username" value={username} onChange={e => setUsername(e.target.value)} maxLength={30} placeholder="Lichess username" required /></label><label>Speed<select aria-label="Lichess speed" value={speed} onChange={e => setSpeed(e.target.value as LichessSpeed)}>{LICHESS_SPEEDS.map(s => <option key={s} value={s}>{s}</option>)}</select></label><button disabled={importBusy || !username.trim()}>{importBusy ? 'Loading games…' : 'Load recent games'}</button></form>{importError && <p role="alert" className="error">{importError}</p>}{lichess && <><p className="muted">{lichess.games.length} games imported · {lichess.rejected.length} excluded · latest sample, not full account history.</p><div className="imported-games">{lichess.games.map(g => <button key={g.id} onClick={() => selectImported(g)}>{g.speed} · {g.playerColor} vs {g.opponent ?? 'opponent'} · {g.opening?.name ?? g.id}<small>{new Date(g.createdAt).toLocaleDateString()} · Load and review</small></button>)}</div><h3>Observed opening dip and recovery</h3>{openingReport?.groups.filter(g => g.games > 0).map(g => <p className="muted" key={g.speed + g.color}>{g.speed} / {g.color}: {g.games} games, {g.gamesWithOpeningEvaluations} with opening evaluations. Dip then recovery: {g.dipRecoveryGames} / {g.patternEligibleGames} measurable games.</p>)}<p className="fine-print">Based on supplied Lichess evaluations in the first 12 player turns. A dip and recovery each require ≥100 cp and three observed positions in the same game. Sparse coverage can miss swings; missing scores are not filled in. This does not establish an overall opening weakness.</p></>}</details>
      <div className="workspace">
        <section className="board-column" aria-label="Position viewer"><div className="position-heading"><h2>{board.turn() === 'w' ? 'White' : 'Black'} to move {board.isCheck() ? '· Check' : ''}</h2><button className="quiet" onClick={() => setFlipped(v => !v)}>Flip board</button></div>
          <div tabIndex={0} aria-label="Board navigation: left and right arrow keys" onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); navigate(ply + (e.key === 'ArrowLeft' ? -1 : 1)) } }}><Board fen={fen} flipped={flipped} /></div>
          <nav className="navigation" aria-label="Move navigation"><button aria-label="First position" onClick={() => navigate(0)} disabled={ply === 0}>|‹</button><button aria-label="Previous move" onClick={() => navigate(ply - 1)} disabled={ply === 0}>‹</button><span>Position {ply} / {game.sans.length}</span><button aria-label="Next move" onClick={() => navigate(ply + 1)} disabled={ply === game.sans.length}>›</button><button aria-label="Last position" onClick={() => navigate(game.sans.length)} disabled={ply === game.sans.length}>›|</button></nav>
          <div className="card move-card"><div className="section-heading"><h3>Game moves</h3><span className="muted">{game.completed ? `Completed · ${game.result}` : 'Study / unfinished'}</span></div><div className="moves">{game.sans.length ? game.sans.map((san, i) => <button key={i} aria-current={ply === i + 1 ? 'step' : undefined} className={ply === i + 1 ? 'selected' : ''} onClick={() => navigate(i + 1)}><span>{game.fens[i].split(' ')[5]}{game.fens[i].split(' ')[1] === 'w' ? '.' : '…'}</span> {san}</button>) : <p className="muted">Load a PGN to navigate its moves.</p>}</div></div>
          <details className="fen-details"><summary>Current FEN</summary><code data-testid="current-fen">{fen}</code></details>
          <section className="card"><h3>Position notes</h3><label className="muted">Saved only in this browser<textarea aria-label="Position notes" value={notes[fen] ?? ''} onChange={e => saveNote(e.target.value)} maxLength={6000} rows={3} placeholder="What will you remember next time?" /></label>{storageError && <p role="status">{storageError}</p>}<button className="quiet" disabled={!notes[fen]} onClick={() => saveNote('')}>Clear this note</button></section>
        </section>
        <div className="insight-column">
          <section className="card critical-card"><div className="section-heading"><h2>2. Critical decisions</h2><button disabled={scanning || !game.sans.length} onClick={() => void scan(game, gameVersion.current)}>Scan game</button></div>
            <p className="muted">For {color === 'w' ? 'White' : 'Black'} · positions where alternatives are less forgiving. Select a moment, then ask Queen below.</p>
            {scanning && <div role="status"><progress value={progress[0]} max={progress[1] || 1} /><p>Reviewing locally: {progress[0]} / {progress[1]} positions</p><button onClick={() => { scanController.current?.abort(); setScanning(false) }}>Stop review</button></div>}
            {scanError && <p className="error" role="alert">{scanError}</p>}
            {!scanning && !critical.length && <p className="empty">Review a PGN to find a focused place to start.</p>}
            <div className="critical-list">{filtered.slice(0, 5).map((p, i) => <button key={p.ply} className={`critical-item ${ply === p.ply ? 'active' : ''}`} onClick={() => navigate(p.ply)}><span className="number">{i + 1}</span><span><strong>Before {label(game, p.ply)}</strong><small>Best: {safeSan(p.fen, [p.bestMove])} · pressure {p.score.toFixed(0)}/100 · depth {p.analysis.depth}{game.elapsed[p.ply] !== undefined ? ` · reconstructed ${game.elapsed[p.ply]}s` : ' · move time unknown'}</small></span><span>↗</span></button>)}</div>
            {critical.length > 0 && <p className="fine-print">Ranking uses a bounded, shallow MultiPV best-versus-second gap, not your move's error or proven value of extra time. Review these moments for future time allocation. Clock tags reconstruct estimates; actual elapsed time is uncertain. Scan limit: 120 plies.</p>}
          </section>
          <section className="card queen-card" aria-labelledby="queen-heading"><div className="section-heading"><h2 id="queen-heading">3. Talk it through with Queen</h2><span className="tag">Hosted model</span></div>
            <p className="muted">Ask for a plan, compare your move, or follow up on the explanation. Each position keeps its own conversation during this session.</p>
            <label className="consent"><input type="checkbox" checked={consent} onChange={e => { setConsent(e.target.checked); if (!e.target.checked) { queenController.current?.abort(); queenSequence.current++; setQueenBusy(false) } }} /><span>I allow sending this position, played move history, my question and recent follow-ups to the public Hugging Face Queen Space. Names, PGN comments and notes are excluded.</span></label>
            {turns.map((turn, i) => <article className="conversation" key={i}><p className="question"><strong>You</strong> {turn.question}</p><div className="answer"><span className="eyebrow">QUEEN · UNCHECKED EXPLANATION</span><p className="queen-move">Selected legal move: <strong>{safeSan(fen, [turn.result.selected_move_uci])}</strong></p>{turn.result.fallback_used && <p className="warning">{turn.result.random_fallback ? 'Provider returned a random legal fallback.' : `Provider used fallback selection: ${turn.result.move_source}.`}</p>}<pre className="prose">{turn.result.explanation}</pre>{turn.result.pv_uci.length > 0 && <p className="pv">Legality-checked line: {safeSan(fen, turn.result.pv_uci)}{!turn.result.pv_matches_selected && ' · differs from selected move'}</p>}{turn.result.pv_truncated_at !== undefined && <p className="warning">The continuation was truncated at its first illegal move.</p>}<small className="muted">{turn.result.cache_hit ? 'Cached response' : `${(turn.result.elapsed_ms / 1000).toFixed(1)}s`} · {turn.result.history_note ?? (turn.result.history_transmitted ? 'Played history included' : 'Current FEN only')}</small></div></article>)}
            <form onSubmit={e => { e.preventDefault(); void ask() }}><label>Your question<textarea aria-label="Your question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={1400} rows={3} /></label><div className="actions"><button className="primary" type="submit" disabled={!consent || queenBusy || !question.trim() || board.isGameOver()}>{queenBusy ? 'Queen is thinking…' : turns.length ? 'Ask follow-up' : 'Ask Queen about this position'}</button>{queenBusy && <button type="button" onClick={() => { queenController.current?.abort(); queenSequence.current++; setQueenBusy(false) }}>Cancel</button>}</div></form>
            {board.isGameOver() && <p className="muted">The position is terminal. Select an earlier decision to ask Queen.</p>}{queenError && <p role="alert" className="error">{queenError}</p>}
            <p className="fine-print">Queen's prose is unchecked and may be wrong. Move legality is checked; playing strength and strategic claims are not verified. Public Space availability and quota can limit replies. No automatic retries.</p>
            <details><summary>Model provenance</summary><p className="fine-print">princeton-nlp/queen_pawn-8 via hugging-apps/queen-pawn-8. Reviewed revision 5027687fac08b64b2403b13aca5b198e68294fe9. The Space loads an unpinned model; live remote weights are not attested. This is hosted inference, not on-device Queen.</p></details>
          </section>
          <section className="card"><div className="section-heading"><h2>Check with Stockfish</h2><button onClick={() => void analyze()} disabled={engineBusy}>{engineBusy ? 'Analyzing locally…' : 'Analyze position'}</button></div><p className="muted">Runs on this device. Scores below are from White's perspective.</p>{measured && <p className="evaluation"><strong>{formatEval(measured, board.turn() === 'w')}</strong><span>depth {measured.depth} · best {measured.bestmove === '(none)' ? 'none' : safeSan(fen, [measured.bestmove])}</span></p>}{lines?.lines.map(line => <p className="engine-line" key={line.rank}><strong>{line.rank}.</strong> {safeSan(fen, line.pv.slice(0, 8))}<small> {line.cp !== undefined ? `${((board.turn() === 'w' ? 1 : -1) * line.cp / 100).toFixed(2)}` : `mate ${line.mate} (side to move)`} · depth {lines.depth}</small></p>)}{engineError && <p role="alert" className="error">{engineError}</p>}</section>
        </div>
      </div>
    </main><footer>ChessLLM Coach · Your board, notes and local analysis stay in your browser. Only an explicit Queen request shares context externally.</footer>
  </div>
}

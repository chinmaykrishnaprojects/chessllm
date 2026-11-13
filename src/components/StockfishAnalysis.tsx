import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { formatEval, getCachedStockfishEval, getStockfishEngine, stockfishCacheKey, whiteScore } from '../lib/stockfishUci'
import type { StockfishEval } from '../lib/stockfishUci'
import './StockfishAnalysis.css'

export interface StockfishAnalysisProps {
  /** The position currently displayed on the board (including historical views). */
  fen: string
  /** SAN moves from the standard starting position, matching MoveHistory. */
  history?: string[]
  /** -1 = start, n = after SAN move n, null/undefined = live. */
  viewingIndex?: number | null
  onNavigate?: (index: number | null) => void
}

function scoreHeight(result: StockfishEval | undefined, fen: string): number | undefined {
  if (!result) return undefined
  const score = whiteScore(result, fen.split(' ')[1] === 'w')
  if (score === undefined) return undefined
  // A bounded display scale in pawns, not a win-probability/strength estimate.
  return Math.max(-600, Math.min(600, score))
}

export default function StockfishAnalysis({ fen, history, viewingIndex = null, onNavigate }: StockfishAnalysisProps) {
  const id = useId()
  const [depth, setDepth] = useState(12)
  const [movetime, setMovetime] = useState(750)
  const [retry, setRetry] = useState(0)
  const [measured, setMeasured] = useState<Map<string, StockfishEval>>(() => new Map())
  const [status, setStatus] = useState<{ key: string; text: string; error?: boolean } | null>(null)
  const [batch, setBatch] = useState<{ key: string; done: number; running: boolean; error?: string } | null>(null)
  const batchController = useRef<AbortController | null>(null)
  const historyKey = JSON.stringify(history ?? [])
  const standaloneFen = history === undefined ? fen : undefined
  const gameKey = `${historyKey}:${standaloneFen ?? ''}:${depth}:${movetime}`
  const currentKey = stockfishCacheKey(fen, depth, movetime)

  const game = useMemo(() => {
    if (standaloneFen !== undefined) return { positions: [standaloneFen], error: '' }
    const moves: string[] = JSON.parse(historyKey)
    const board = new Chess()
    const positions = [board.fen()]
    try {
      for (const san of moves) { board.move(san); positions.push(board.fen()) }
      return { positions, error: '' }
    } catch { return { positions, error: 'Move history could not be replayed. The graph stops at the last valid position.' } }
  }, [historyKey, standaloneFen])

  const remember = (key: string, result: StockfishEval) => setMeasured(previous => {
    const next = new Map(previous)
    next.delete(key)
    next.set(key, result)
    while (next.size > 256) next.delete(next.keys().next().value!)
    return next
  })

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setStatus({ key: currentKey, text: 'Analyzing displayed position…' })
      void (async () => {
        try {
          const engine = await getStockfishEngine()
          if (controller.signal.aborted) return
          const result = await engine.analyze(fen, depth, movetime, controller.signal)
          if (controller.signal.aborted) return
          remember(currentKey, result)
          setStatus({ key: currentKey, text: result.scoreCp === undefined && result.scoreMate === undefined
            ? 'Search finished without an exact evaluation. Analyze again to retry.' : 'Analysis complete' })
        } catch (error) {
          if (!controller.signal.aborted) setStatus({ key: currentKey, text: error instanceof Error ? error.message : String(error), error: true })
        }
      })()
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [fen, depth, movetime, currentKey, retry])

  // A new game or search limit invalidates a batch, while navigation does not.
  useEffect(() => () => { batchController.current?.abort() }, [gameKey])

  const analyzeGame = async () => {
    batchController.current?.abort()
    const controller = new AbortController()
    batchController.current = controller
    setBatch({ key: gameKey, done: 0, running: true })
    let done = 0
    try {
      const engine = await getStockfishEngine()
      for (const position of game.positions) {
        if (controller.signal.aborted) break
        const result = await engine.analyze(position, depth, movetime, controller.signal)
        if (controller.signal.aborted) break
        remember(stockfishCacheKey(position, depth, movetime), result)
        setBatch({ key: gameKey, done: ++done, running: true })
      }
      if (!controller.signal.aborted) setBatch({ key: gameKey, done, running: false })
    } catch (error) {
      if (!controller.signal.aborted) setBatch({ key: gameKey, done, running: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const stopBatch = () => {
    batchController.current?.abort()
    setBatch(previous => previous ? { ...previous, running: false } : null)
  }

  const result = measured.get(currentKey) ?? getCachedStockfishEval(fen, depth, movetime)
  const cp = scoreHeight(result, fen)
  const label = result ? formatEval(result, fen.split(' ')[1] === 'w') : 'Unmeasured'
  const points = game.positions.map(position => {
    const value = measured.get(stockfishCacheKey(position, depth, movetime)) ?? getCachedStockfishEval(position, depth, movetime)
    return { position, result: value, cp: scoreHeight(value, position) }
  })
  const measuredCount = points.filter(point => point.cp !== undefined).length
  const selected = viewingIndex === null ? points.length - 1 : viewingIndex + 1
  const scopedStatus = status?.key === currentKey ? status : null
  const scopedBatch = batch?.key === gameKey ? batch : null
  const x = (index: number) => points.length === 1 ? 300 : 32 + index * 536 / (points.length - 1)
  const y = (value: number) => 88 - value / 600 * 62
  const navigate = (index: number) => onNavigate?.(index === points.length - 1 ? null : index - 1)

  return (
    <section className="stockfish-analysis" aria-labelledby={`${id}-title`}>
      <div className="sf-analysis-heading">
        <h3 id={`${id}-title`}>Stockfish analysis</h3>
        <span className="sf-local-badge">On this device</span>
      </div>
      <p className="sf-explanation">Stockfish evaluates the displayed position in your browser.</p>
      <div className="sf-analysis-controls">
        <label htmlFor={`${id}-depth`}>Max depth
          <select id={`${id}-depth`} value={depth} onChange={event => setDepth(Number(event.target.value))}>
            {[8, 12, 16, 20].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label htmlFor={`${id}-time`}>Time limit
          <select id={`${id}-time`} value={movetime} onChange={event => setMovetime(Number(event.target.value))}>
            {[250, 750, 1500, 3000].map(value => <option key={value} value={value}>{value} ms</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setRetry(value => value + 1)}>Analyze position</button>
      </div>
      <div className="sf-position-result">
        <div className={`sf-evaluation-bar ${cp === undefined ? 'sf-unmeasured' : ''}`} role="img"
          aria-label={`White-relative evaluation: ${label}`} title="White below, Black above. Display capped at ±6 pawns; not a win probability.">
          {cp !== undefined && <div className="sf-white-fill" style={{ height: `${50 + cp / 12}%` }} />}
          <span className="sf-bar-w">W</span><span className="sf-bar-b">B</span>
        </div>
        <div className="sf-result-text" aria-live="polite">
          <div className="sf-evaluation-value">{label}</div>
          <p>{viewingIndex === null ? 'Displayed position' : viewingIndex < 0 ? 'Starting position' : `After move ${viewingIndex + 1}`} · White perspective</p>
          {result && <>
            <p>{result.terminal ? 'Verified terminal position' : `Depth ${result.depth} · ${result.timeMs} ms${result.nodes === undefined ? '' : ` · ${result.nodes.toLocaleString()} nodes`}`}</p>
            {!result.terminal && <p>Best move: <code>{result.bestmove}</code></p>}
            {result.pv.length > 0 && <p className="sf-principal-variation">PV (UCI): <code>{result.pv.slice(0, 12).join(' ')}</code></p>}
          </>}
          {scopedStatus && <p className={scopedStatus.error ? 'sf-analysis-error' : 'sf-analysis-status'}>{scopedStatus.text}</p>}
        </div>
      </div>
      <div className="sf-graph-heading">
        <h4>Game evaluation</h4>
        <span>{measuredCount}/{points.length} measured positions</span>
      </div>
      <svg className="sf-evaluation-graph" viewBox="0 0 600 196" role="group" aria-label="White-relative game evaluation. Hollow markers in the bottom row are unmeasured; no values are interpolated across gaps.">
        <line className="sf-graph-zero" x1="32" x2="568" y1="88" y2="88" />
        <text x="3" y="30">+6</text><text x="8" y="92">0</text><text x="3" y="153">−6</text>
        <text x="32" y="191">Start</text><text x="568" y="191" textAnchor="end">Latest</text>
        <text x="300" y="176" textAnchor="middle">○ Unmeasured positions</text>
        {points.map((point, index) => {
          const previous = points[index - 1]
          const text = `Position ${index}: ${point.result ? formatEval(point.result, point.position.split(' ')[1] === 'w') : 'Unmeasured'}`
          const isSelected = selected === index && point.position === fen
          return <g key={`${index}:${point.position}`}>
            {point.cp !== undefined && previous?.cp !== undefined && <line className="sf-graph-line" x1={x(index - 1)} x2={x(index)} y1={y(previous.cp)} y2={y(point.cp)} />}
            {isSelected && <line className="sf-graph-selection" x1={x(index)} x2={x(index)} y1="16" y2="165" />}
            <circle className={`sf-graph-point ${point.cp === undefined ? 'sf-point-unmeasured' : ''} ${isSelected ? 'sf-point-selected' : ''}`}
              cx={x(index)} cy={point.cp === undefined ? 163 : y(point.cp)} r={isSelected ? 5 : 3.5}
              role={onNavigate ? 'button' : 'img'} tabIndex={onNavigate ? 0 : undefined} aria-label={text}
              onClick={() => navigate(index)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(index) } }}>
              <title>{text}</title>
            </circle>
          </g>
        })}
      </svg>
      <p className="sf-graph-caption">White advantage above zero; Black below. Scale capped at ±6 pawns; mate sits at the edge. Only adjacent measured points are joined.</p>
      {game.error && <p className="sf-analysis-error">{game.error}</p>}
      <div className="sf-game-actions">
        <button type="button" disabled={scopedBatch?.running || !!game.error} onClick={() => void analyzeGame()}>Analyze game</button>
        {scopedBatch?.running && <button type="button" onClick={stopBatch}>Stop</button>}
        {scopedBatch && <span role="status">{scopedBatch.running ? 'Analyzing' : 'Stopped / complete'} · {scopedBatch.done}/{points.length}</span>}
      </div>
      {scopedBatch?.error && <p className="sf-analysis-error">{scopedBatch.error}</p>}
      <p className="sf-analysis-footer">Results are cached on this device for the exact position and search limits. <a href={`${import.meta.env.BASE_URL}stockfish/SOURCE.md`} target="_blank" rel="noreferrer">Engine source &amp; license</a></p>
    </section>
  )
}

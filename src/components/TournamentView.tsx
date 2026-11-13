import { useEffect, useRef, useState } from 'react'
import ChessBoard from './ChessBoard'
import EngineStatus from './EngineStatus'
import {
  CHECKPOINT_KEY, DEFAULT_CONFIG, TournamentRunner, createBrowserMoveProvider, createTournament,
  exportTournamentPgn, parseCheckpoint, participantDescription, standings,
} from '../lib/tournament'
import type { Participant, PositionEvent, TournamentConfig, TournamentState } from '../lib/tournament'
import './TournamentView.css'

interface TournamentViewProps { onPosition?: (position: Readonly<PositionEvent>) => void }
function readSaved(): { state: TournamentState | null; error: string } {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY)
    return { state: raw ? parseCheckpoint(raw) : null, error: '' }
  } catch (error) {
    return { state: null, error: `Saved tournament could not be loaded: ${error instanceof Error ? error.message : String(error)}` }
  }
}
const noMove = async () => false

export default function TournamentView({ onPosition }: TournamentViewProps = {}) {
  const [saved] = useState(readSaved)
  const [state, setState] = useState<TournamentState | null>(saved.state)
  const [issue, setIssue] = useState(saved.error)
  const [draft, setDraft] = useState<TournamentConfig>(() => ({
    ...structuredClone(saved.state?.config ?? DEFAULT_CONFIG),
    participants: DEFAULT_CONFIG.participants.map(p => structuredClone(saved.state?.config.participants.find(s => s.id === p.id) ?? p)),
  }))
  const [enabled, setEnabled] = useState(() => (saved.state?.config ?? DEFAULT_CONFIG).participants.map(p => p.id))
  const [selectedGame, setSelectedGame] = useState<string | null>(null)
  const runner = useRef<TournamentRunner | null>(null)
  const callback = useRef(onPosition)
  useEffect(() => { callback.current = onPosition }, [onPosition])
  useEffect(() => () => {
    try { runner.current?.dispose() } catch { /* runner already reports storage failures */ }
  }, [])

  const makeRunner = (snapshot: TournamentState) => {
    const provider = createBrowserMoveProvider()
    return new TournamentRunner(snapshot, {
      move: provider.move, dispose: provider.dispose,
      save: text => localStorage.setItem(CHECKPOINT_KEY, text),
      onState: setState,
      onPosition: position => callback.current?.(position),
    })
  }
  const action = (fn: () => void | Promise<void>) => {
    setIssue('')
    try { void Promise.resolve(fn()).catch(error => setIssue(error instanceof Error ? error.message : String(error))) }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  const start = () => action(() => {
    const snapshot = createTournament({ ...draft, participants: draft.participants.filter(p => enabled.includes(p.id)) })
    runner.current?.dispose()
    runner.current = makeRunner(snapshot)
    setSelectedGame(null)
    setState(snapshot)
    return runner.current.start()
  })
  const resume = () => action(() => {
    if (!state) return
    runner.current ??= makeRunner(state)
    setSelectedGame(null)
    return runner.current.resume()
  })
  const stop = () => action(() => {
    if (!state) return
    runner.current ??= makeRunner(state)
    runner.current.stop()
  })
  const updateParticipant = (id: string, update: Partial<Participant>) => {
    setDraft(current => ({ ...current, participants: current.participants.map(p => p.id === id ? { ...p, ...update } as Participant : p) }))
  }
  const download = () => action(() => {
    if (!state) return
    const url = URL.createObjectURL(new Blob([exportTournamentPgn(state)], { type: 'application/x-chess-pgn;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `chessllm-tournament-${state.id}.pgn`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })

  const running = state?.status === 'running'
  const resumable = state?.status === 'paused' || state?.status === 'error'
  const completed = state?.games.filter(g => g.status === 'completed').length ?? 0
  const current = state?.games.find(g => g.id === selectedGame)
    ?? state?.games.find(g => ['running', 'error', 'aborted'].includes(g.status))
    ?? state?.games.find(g => g.status === 'pending')
    ?? state?.games.at(-1)
  const player = (id: string) => state?.config.participants.find(p => p.id === id)?.name ?? id
  const rows = state ? standings(state) : []
  const total = enabled.length * (enabled.length - 1) * draft.cycles

  return <section className="tournament-view" aria-label="Browser tournament">
    <header className="tournament-heading">
      <div><span className="tournament-eyebrow">ChessLLM / Browser arena</span><h1>Tournament</h1>
        <p>Every pair plays both colors. Models and Stockfish run on this device.</p></div>
      <span className={`tournament-status ${running ? 'is-running' : ''}`} role="status">{state?.status ?? 'Ready'}</span>
    </header>
    <EngineStatus />
    {(issue || state?.error) && <div className="tournament-error" role="alert">{issue || state?.error} No error or interrupted game is scored as a forfeit. Resume retries the saved position.</div>}
    {resumable && <p className="tournament-notice">Checkpoint available · {completed}/{state.games.length} games finished. Nothing runs automatically. Choose <strong>Resume tournament</strong> to continue with the saved settings.</p>}
    <div className="tournament-layout">
      <aside className="tournament-setup">
        <h2>Next tournament</h2>
        <fieldset disabled={running}>
          <legend>Participants</legend>
          {draft.participants.map(p => <div className="tournament-participant" key={p.id}>
            <label className="tournament-check"><input type="checkbox" checked={enabled.includes(p.id)} onChange={e => setEnabled(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} />{p.name}</label>
            {p.kind === 'chessgpt' ? <>
              <label>Temperature<input aria-label={`${p.name} temperature`} type="number" min="0" max="5" step="0.1" value={p.temperature} onChange={e => updateParticipant(p.id, { temperature: e.target.valueAsNumber })} /></label>
              <details><summary>Sampling settings</summary>
                <label className="tournament-check"><input type="checkbox" checked={p.turbo} onChange={e => updateParticipant(p.id, { turbo: e.target.checked })} />Turbo prefix pruning</label>
                <label>Top p<input type="number" min="0.01" max="1" step="0.01" value={p.topP} onChange={e => updateParticipant(p.id, { topP: e.target.valueAsNumber })} /></label>
                <label>Min p (fraction of peak)<input type="number" min="0" max="1" step="0.01" value={p.minP} onChange={e => updateParticipant(p.id, { minP: e.target.valueAsNumber })} /></label>
              </details>
            </> : <div className="tournament-budget">
              <label>Depth limit<input type="number" min="1" max="40" value={p.depth} onChange={e => updateParticipant(p.id, { depth: e.target.valueAsNumber })} /></label>
              <label>Milliseconds / move<input type="number" min="10" max="60000" step="10" value={p.movetimeMs} onChange={e => updateParticipant(p.id, { movetimeMs: e.target.valueAsNumber })} /></label>
            </div>}
          </div>)}
          <p className="tournament-help">Stockfish stops at the first search limit reached. Search budget is not a calibrated Elo rating. Temperature 0 chooses greedily.</p>
          <label>Paired rounds<input type="number" min="1" max="20" value={draft.cycles} onChange={e => setDraft(d => ({ ...d, cycles: e.target.valueAsNumber }))} /></label>
          <label>New plies per game (cap)<input type="number" min="1" max="1000" value={draft.maxPlies} onChange={e => setDraft(d => ({ ...d, maxPlies: e.target.valueAsNumber }))} /></label>
          <p className="tournament-help">Default: a short 40-ply run. At the cap, an unfinished game is explicitly adjudicated ½–½; this is separate from a natural draw. Seed moves do not count toward the cap.</p>
          <label>Opening PGN (optional)<textarea rows={3} placeholder="1. e4 e5 2. Nf3 Nc6" value={draft.seedPgn} onChange={e => setDraft(d => ({ ...d, seedPgn: e.target.value }))} /></label>
          <p className="tournament-help">Use history from the standard starting position. FEN-only positions cannot supply ChessGPT's context. Each color pairing uses the same opening.</p>
        </fieldset>
        <button className="tournament-primary" disabled={running || enabled.length < 2} onClick={start}>{state ? 'Start new tournament' : 'Start tournament'} · {Number.isFinite(total) ? total : '—'} games</button>
        {resumable && <p className="tournament-help">Starting a new tournament replaces this device's saved checkpoint.</p>}
        <div className="tournament-controls">
          {running && <button onClick={() => action(() => runner.current?.pause())}>Pause tournament</button>}
          {resumable && <button className="tournament-primary" onClick={resume}>Resume tournament</button>}
          {(running || resumable) && <button onClick={stop}>Stop tournament</button>}
          <button disabled={!state?.games.some(g => g.status !== 'pending')} onClick={download}>Download PGN</button>
        </div>
        <p className="tournament-help">A versioned checkpoint is saved locally after every ply. Pause cancels the current request; Stop leaves the unfinished game unscored. Keep this tab open while running.</p>
      </aside>

      <div className="tournament-results">
        <section className="tournament-card" aria-label="Standings">
          <div className="tournament-section-title"><h2>Standings</h2><span>{completed} / {state?.games.length ?? 0} complete</span></div>
          <div className="tournament-scroll"><table><thead><tr><th>Participant</th><th>Played</th><th>W</th><th>L</th><th>Natural D</th><th>Cap ½</th><th>Points</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{row.played}</td><td>{row.wins}</td><td>{row.losses}</td><td>{row.draws}</td><td>{row.adjudications}</td><td><strong>{row.points}</strong></td></tr>)}</tbody></table></div>
          {!state && <p className="tournament-empty">Start a tournament to build the paired-color schedule and follow every game.</p>}
          <p className="tournament-help">Win 1 · natural draw ½ · explicit cap adjudication ½ · unfinished/error 0 games played. Results describe this run; no calibrated ratings are inferred.</p>
        </section>

        {current && <section className="tournament-card tournament-live" aria-label="Game viewer">
          <div className="tournament-section-title"><h2>{current.id.replace('game-', 'Game ')}</h2><button onClick={() => setSelectedGame(null)} disabled={selectedGame === null}>Follow live</button></div>
          <p className="tournament-matchup">{player(current.whiteId)} <span>White</span><br />{player(current.blackId)} <span>Black</span></p>
          <p role="status">{current.status} · {current.plies} new plies · {current.result ?? '*'}{current.termination ? ` · ${current.termination}` : running && current.status === 'running' ? ` · ${current.fen.split(' ')[1] === 'w' ? 'White' : 'Black'} thinking…` : ''}</p>
          <ChessBoard fen={current.fen} onMove={noMove} isFlipped={false} playerColor="white" disabled hintsMode="off" />
          <label>Game PGN<textarea readOnly rows={4} value={current.pgn || '(Starting position)'} /></label>
          {current.error && <p className="tournament-error">{current.error}</p>}
        </section>}

        {state && <section className="tournament-card" aria-label="Fixtures and results">
          <h2>Fixtures & results</h2>
          <details><summary>Saved settings for this run</summary>{state.config.participants.map(p => <p className="tournament-help" key={p.id}>{p.name}: {participantDescription(p)}</p>)}<p className="tournament-help">Cap: {state.config.maxPlies} new plies · {state.config.cycles} paired round(s)</p></details>
          <div className="tournament-scroll"><table><thead><tr><th>Game</th><th>White</th><th>Black</th><th>Result</th><th>Ending / status</th></tr></thead><tbody>
            {state.games.map(g => <tr key={g.id} className={g.id === current?.id ? 'is-selected' : ''}><td><button onClick={() => setSelectedGame(g.id)} aria-label={`Review ${g.id}`}>{g.id.slice(5)}</button></td><td>{player(g.whiteId)}</td><td>{player(g.blackId)}</td><td>{g.result ?? '*'}</td><td>{g.termination ?? `${g.status}${g.status === 'error' || g.status === 'aborted' ? ' · unscored' : ''}`}</td></tr>)}
          </tbody></table></div>
        </section>}
      </div>
    </div>
  </section>
}

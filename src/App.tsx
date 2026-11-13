import EngineStatus from './components/EngineStatus'
import { chessFetch as fetch } from './lib/recoveryApi'
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Chess } from 'chess.js'
import ChessBoard from './components/ChessBoard'
import MoveHistory from './components/MoveHistory'
import AnalysisPanel from './components/AnalysisPanel'
import ControlPanel from './components/ControlPanel'
import MaterialCount from './components/MaterialCount'
import GameModal from './components/GameModal'
import LLMvsLLMPanel from './components/LLMvsLLMPanel'
import type { BotConfig } from './components/LLMvsLLMPanel'
import TopNav from './components/TopNav'
import type { AppMode, HintsMode, BoardTheme } from './components/TopNav'
import MethodTest from './components/MethodTest'
import TournamentView from './components/TournamentView'
import StockfishAnalysis from './components/StockfishAnalysis'
import PgnImport from './components/PgnImport'
import { cloneWithHistory, observedMoveProbability, probabilityContextKey, withPlyTelemetry } from './lib/telemetry'
import type { MoveTelemetry, PlyRecord } from './lib/telemetry'
import './App.css'

// Simple hash-based routing for test page
const isTestPage = window.location.hash === '#/test' || window.location.pathname === '/test'

// Use relative URL in production, localhost in development
const API_URL = '/api'

// Lichess sounds - using GitHub raw for reliability
const SOUND_URLS = {
  move: 'https://raw.githubusercontent.com/lichess-org/lila/master/public/sound/standard/Move.mp3',
  capture: 'https://raw.githubusercontent.com/lichess-org/lila/master/public/sound/standard/Capture.mp3',
}

const playSound = (type: 'move' | 'capture', enabled: boolean) => {
  if (!enabled) return
  const audio = new Audio(SOUND_URLS[type])
  audio.volume = 0.5
  audio.play().catch(() => { /* ignore autoplay errors */ })
}

interface MoveProb {
  move: string
  prob: number
  from_square?: string
  to_square?: string
}

function App() {
  const gameEpoch = useRef(0)
  // Game state
  const [game, setGame] = useState(new Chess())
  const [fen, setFen] = useState(game.fen())
  const [pgn, setPgn] = useState('')
  const [moveHistory, setMoveHistory] = useState<string[]>([])
  const [viewingMoveIndex, setViewingMoveIndex] = useState<number | null>(null)  // null = viewing current position
  const currentGameRef = useRef(game)
  const playAbortRef = useRef(new AbortController())
  const [moveRecords, setMoveRecords] = useState<(PlyRecord | undefined)[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [showPgnImport, setShowPgnImport] = useState(false)

  // UI state
  const [playerColor, setPlayerColor] = useState<'white' | 'black'>('white')
  const [isFlipped, setIsFlipped] = useState(false)
  const [showModal, setShowModal] = useState(true)
  const [isThinking, setIsThinking] = useState(false)
  const [gameOver, setGameOver] = useState(false)
  const [result, setResult] = useState('')

  // Settings
  const [temperature, setTemperature] = useState(0.3)
  const [model, setModel] = useState('stockfish')
  const [analysisMode, setAnalysisMode] = useState(false)
  const [showOpponentPrediction, setShowOpponentPrediction] = useState(false)
  const [turboMode, setTurboMode] = useState(true)  // Pruned legal SAN scoring; OFF uses exact scoring
  const [thinkingMode, setThinkingMode] = useState(true)  // Activity indicator only
  const [hintsMode, setHintsMode] = useState<HintsMode>('on')  // Legal move hints: 'off' | 'partial' | 'on'
  const [showMaterial, setShowMaterial] = useState(true)  // Show material count
  const [boardTheme, setBoardTheme] = useState<BoardTheme>('green')  // Board color theme
  const [soundEnabled, setSoundEnabled] = useState(true)  // Sound effects
  const [showCheckHighlight, setShowCheckHighlight] = useState(false)  // Check highlight (off by default like chess.com)
  const [appMode, setAppMode] = useState<AppMode>('play')

  // Analysis
  const [lastOpponentPrediction, setLastOpponentPrediction] = useState<MoveProb[]>([])
  const [lastMove, setLastMove] = useState<{ from: string, to: string } | null>(null)
  const [illegalMoves, setIllegalMoves] = useState<{ move: string, context: string }[]>([])
  // The distribution predicts the NEXT move from its precise FEN/PGN/model/temperature context.
  const probsCacheRef = useRef<Map<string, MoveProb[]>>(new Map())
  const [, setProbabilitiesVersion] = useState(0)
  const cacheProbabilities = useCallback((sourceFen: string, sourcePgn: string, sourceModel: string, sourceTemperature: number, probabilities: MoveProb[]) => {
    probsCacheRef.current.set(probabilityContextKey(sourceFen, sourcePgn, sourceModel, sourceTemperature), probabilities)
    setProbabilitiesVersion(v => v + 1)
  }, [])

  // LLM vs LLM match state
  const [llmMatchRunning, setLlmMatchRunning] = useState(false)
  const [llmMatchPaused, setLlmMatchPaused] = useState(false)
  const llmMatchPausedRef = useRef(false)  // Ref for async access in game loop
  const [llmMatchCurrentGame, setLlmMatchCurrentGame] = useState(1)
  const [llmMatchTotalGames, _setLlmMatchTotalGames] = useState(1)  // Phase 2
  const [llmMatchResults, setLlmMatchResults] = useState({ white: 0, black: 0, draws: 0 })
  const [llmWhiteConfig, setLlmWhiteConfig] = useState<BotConfig | null>(null)
  const [llmBlackConfig, setLlmBlackConfig] = useState<BotConfig | null>(null)
  const [, setLlmMatchPgns] = useState<string[]>([])  // Phase 2 PGN export
  const [llmMatchAbortController, setLlmMatchAbortController] = useState<AbortController | null>(null)

  // Sync pause ref with state
  useEffect(() => {
    llmMatchPausedRef.current = llmMatchPaused
  }, [llmMatchPaused])

  // Build PGN from move history
  const buildPgn = useCallback((moves: string[]) => {
    let pgn = ''
    for (let i = 0; i < moves.length; i++) {
      if (i % 2 === 0) {
        pgn += `${Math.floor(i / 2) + 1}. `
      }
      pgn += moves[i] + ' '
    }
    return pgn.trim()
  }, [])

  // Compute the FEN at a specific move index (-1 = starting position, null = current game FEN)
  const viewingPosition = useMemo(() => {
    if (viewingMoveIndex === null) return { fen, pgn: buildPgn(moveHistory) }
    const replay = new Chess()
    for (const san of moveHistory.slice(0, viewingMoveIndex + 1)) replay.move(san)
    return { fen: replay.fen(), pgn: buildPgn(replay.history()) }
  }, [viewingMoveIndex, moveHistory, fen, buildPgn])
  const viewingFen = viewingPosition.fen
  const nextTurnConfig = appMode === 'llm-vs-llm'
    ? viewingFen.split(' ')[1] === 'w' ? llmWhiteConfig : llmBlackConfig
    : null
  const viewingKey = probabilityContextKey(viewingPosition.fen, viewingPosition.pgn,
    nextTurnConfig?.model ?? model, nextTurnConfig?.temperature ?? temperature)
  const moveProbabilities = probsCacheRef.current.get(viewingKey) ?? []

  // Handle navigation in move history
  const handleMoveNavigate = useCallback((index: number | null) => {
    setViewingMoveIndex(index)
  }, [])

  const invalidatePending = useCallback(() => {
    gameEpoch.current += 1
    playAbortRef.current.abort()
    playAbortRef.current = new AbortController()
    setIsThinking(false)
  }, [])

  const publishPosition = useCallback((next: Chess) => {
    currentGameRef.current = next
    setGame(next)
    setFen(next.fen())
    const history = next.history()
    setMoveHistory(history)
    setPgn(buildPgn(history))
    setViewingMoveIndex(null)
  }, [buildPgn])

  const contextIsCurrent = useCallback((epoch: number, positionFen: string, positionPgn: string) =>
    epoch === gameEpoch.current && currentGameRef.current.fen() === positionFen &&
      buildPgn(currentGameRef.current.history()) === positionPgn,
  [buildPgn])

  // Request a distribution for the chosen human SAN at its PRE-MOVE position.
  // The response may arrive after later moves; it only updates the matching ply.
  const analyzeHumanPly = useCallback(async (before: Chess, san: string, ply: number, epoch: number, showPrediction: boolean) => {
    const sourceFen = before.fen()
    const sourcePgn = buildPgn(before.history())
    try {
      const response = await fetch(`${API_URL}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: sourceFen, pgn: sourcePgn, model, temperature }),
        signal: playAbortRef.current.signal,
      })
      const data = await response.json()
      if (epoch !== gameEpoch.current || currentGameRef.current.history()[ply] !== san || !data.success) return
      const probabilities = (data.probabilities ?? []) as MoveProb[]
      const telemetry = data.telemetry as MoveTelemetry | undefined
      if (telemetry && telemetry.source_fen === sourceFen && telemetry.source_pgn === sourcePgn &&
          telemetry.model === model && telemetry.temperature === temperature) {
        const observed = observedMoveProbability(probabilities, san)
        setMoveRecords(prev => withPlyTelemetry(prev, ply, san, {
          ...telemetry,
          model_probability: observed,
          surprisal_bits: observed !== undefined && observed > 0 ? -Math.log2(observed) : undefined,
        }))
        cacheProbabilities(sourceFen, sourcePgn, model, temperature, probabilities)
        if (showPrediction) setLastOpponentPrediction(probabilities.slice(0, 5))
      }
    } catch (error) {
      if (epoch === gameEpoch.current && !playAbortRef.current.signal.aborted) console.warn('Human move analysis unavailable:', error)
    }
  }, [buildPgn, cacheProbabilities, model, temperature])

  const analyzeBoard = useCallback(async (board: Chess, historical = false) => {
    const sourceFen = board.fen()
    const sourcePgn = buildPgn(board.history())
    const epoch = gameEpoch.current
    try {
      const response = await fetch(`${API_URL}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fen: sourceFen, pgn: sourcePgn, model, temperature }),
        signal: playAbortRef.current.signal,
      })
      const data = await response.json()
      // A historical position remains valid as a cached, immutable context even
      // if the live game has advanced; a game reset still discards its response.
      if (epoch !== gameEpoch.current || (!historical && !contextIsCurrent(epoch, sourceFen, sourcePgn)) || !data.success) return
      const t = data.telemetry as MoveTelemetry | undefined
      if (t?.source_fen !== sourceFen || t.source_pgn !== sourcePgn || t.model !== model || t.temperature !== temperature) return
      cacheProbabilities(sourceFen, sourcePgn, model, temperature, data.probabilities ?? [])
    } catch (error) {
      if (epoch === gameEpoch.current && !playAbortRef.current.signal.aborted) setErrorMessage(String(error))
    }
  }, [buildPgn, cacheProbabilities, contextIsCurrent, model, temperature])

  // A model result can only advance the exact position that requested it.
  const makeLlmMove = useCallback(async (currentGame: Chess, currentHistory: string[]) => {
    if (currentGame.isGameOver()) return
    const epoch = gameEpoch.current
    const sourceFen = currentGame.fen()
    const sourcePgn = buildPgn(currentHistory)
    const signal = playAbortRef.current.signal
    setIsThinking(true)
    setErrorMessage('')
    try {
      const response = await fetch(API_URL + '/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: sourceFen, pgn: sourcePgn, temperature, model,
          stochastic: temperature > 0, turbo: turboMode,
        }),
        signal,
      })
      const data = await response.json()
      if (!contextIsCurrent(epoch, sourceFen, sourcePgn) || signal.aborted) return
      if (!response.ok || !data.success || !data.move_san) {
        setErrorMessage(data.error ?? 'Model could not produce a move. Retry or choose another model.')
        return
      }
      const newGame = cloneWithHistory(currentGame)
      const chosen = newGame.move(data.move_san)
      const telemetry = data.telemetry as MoveTelemetry | undefined
      const newHistory = newGame.history()
      const validTelemetry = telemetry && telemetry.source_fen === sourceFen &&
        telemetry.source_pgn === sourcePgn && telemetry.model === model &&
        telemetry.temperature === temperature
      if (validTelemetry) {
        setMoveRecords(prev => [...prev.slice(0, currentHistory.length), {
          san: chosen.san, actor: 'engine' as const, telemetry,
        }])
        cacheProbabilities(sourceFen, sourcePgn, model, temperature, data.probabilities ?? [])
      } else {
        setMoveRecords(prev => [...prev.slice(0, currentHistory.length), { san: chosen.san, actor: 'engine' as const }])
      }
      publishPosition(newGame)
      setIllegalMoves(data.illegal_moves ?? [])
      setLastMove({ from: chosen.from, to: chosen.to })
      playSound(chosen.captured ? 'capture' : 'move', soundEnabled)
      if (newGame.isGameOver()) {
        setGameOver(true)
        setResult(newGame.isCheckmate() ? (newGame.turn() === 'w' ? '0-1' : '1-0') : '1/2-1/2')
      }
      void newHistory
    } catch (error) {
      if (epoch === gameEpoch.current && !signal.aborted) {
        setErrorMessage(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (epoch === gameEpoch.current) setIsThinking(false)
    }
  }, [temperature, model, buildPgn, turboMode, soundEnabled, contextIsCurrent, cacheProbabilities, publishPosition])

  // Record the move immediately. Optional inference describes its PRE-MOVE board.
  const onMove = useCallback(async (from: string, to: string, promotion?: string) => {
    if ((appMode === 'play' && isThinking) || llmMatchRunning || viewingMoveIndex !== null) return false
    const before = currentGameRef.current
    const next = cloneWithHistory(before)
    try {
      const move = next.move({ from, to, promotion: promotion || 'q' })
      const epoch = gameEpoch.current
      const ply = before.history().length
      publishPosition(next)
      setMoveRecords(prev => [...prev.slice(0, ply), { san: move.san, actor: 'human' as const }])
      setLastMove({ from: move.from, to: move.to })
      setErrorMessage('')
      playSound(move.captured ? 'capture' : 'move', soundEnabled)
      if (analysisMode || showOpponentPrediction || appMode === 'analysis') {
        void analyzeHumanPly(before, move.san, ply, epoch, showOpponentPrediction)
      }
      if (next.isGameOver()) {
        setGameOver(true)
        setResult(next.isCheckmate() ? (next.turn() === 'w' ? '0-1' : '1-0') : '1/2-1/2')
      } else if (appMode === 'analysis') {
        void analyzeBoard(next)
      } else if (appMode === 'play') {
        void makeLlmMove(next, next.history())
      }
      return true
    } catch {
      return false
    }
  }, [appMode, isThinking, llmMatchRunning, viewingMoveIndex, publishPosition, soundEnabled,
      analysisMode, showOpponentPrediction, analyzeHumanPly, analyzeBoard, makeLlmMove])

  // Start new game
  const startGame = useCallback((color: 'white' | 'black' | 'random') => {
    llmMatchAbortController?.abort()
    setLlmMatchRunning(false)
    setLlmMatchPaused(false)
    invalidatePending()
    const actualColor = color === 'random'
      ? (Math.random() > 0.5 ? 'white' : 'black')
      : color

    const newGame = new Chess()
    publishPosition(newGame)
    setMoveRecords([])
    setPlayerColor(actualColor)
    setIsFlipped(actualColor === 'black')
    setShowModal(false)
    setGameOver(false)
    setResult('')
    setLastOpponentPrediction([])
    setErrorMessage('')
    setLastMove(null)
    setViewingMoveIndex(null)  // Reset to current position on new game
    probsCacheRef.current.clear()
    setProbabilitiesVersion(v => v + 1)

    // If player is black, LLM moves first
    if (actualColor === 'black') {
      makeLlmMove(newGame, [])
    }
  }, [makeLlmMove, invalidatePending, publishPosition, llmMatchAbortController])

  // Takeback
  const takeback = useCallback(() => {
    if (moveHistory.length < 1) return
    invalidatePending()
    const next = cloneWithHistory(currentGameRef.current)
    next.undo()
    publishPosition(next)
    setMoveRecords(prev => prev.slice(0, -1))
    setLastMove(null)
    setLastOpponentPrediction([])
    setIllegalMoves([])
    setGameOver(false)
    setResult('')
    setErrorMessage('')
    probsCacheRef.current.clear()
    setProbabilitiesVersion(v => v + 1)
  }, [moveHistory.length, invalidatePending, publishPosition])

  // Analyze current position
  const analyzePosition = useCallback(async () => {
    if (viewingMoveIndex === null) {
      await analyzeBoard(cloneWithHistory(currentGameRef.current))
      return
    }
    const board = new Chess()
    for (const san of currentGameRef.current.history().slice(0, viewingMoveIndex + 1)) board.move(san)
    await analyzeBoard(board, true)
  }, [analyzeBoard, viewingMoveIndex])

  const importPgn = useCallback((raw: string) => {
    try {
      const next = new Chess()
      next.loadPgn(raw)
      // Native ChessGPT requires standard-start SAN history: reject custom FEN setup.
      if (next.header().SetUp === '1' || next.header().FEN) {
        setErrorMessage('This ChessGPT view supports PGN from the standard starting position. Stockfish analysis can evaluate a custom FEN.')
        return
      }
      invalidatePending()
      publishPosition(next)
      setMoveRecords(next.history().map(san => ({ san, actor: 'unknown' as const })))
      setGameOver(next.isGameOver())
      setResult('')
      setLastMove(null)
      setLastOpponentPrediction([])
      setIllegalMoves([])
      setShowPgnImport(false)
      setShowModal(false)
      setAppMode('analysis')
      setErrorMessage('')
      probsCacheRef.current.clear()
      setProbabilitiesVersion(v => v + 1)
    } catch (error) {
      setErrorMessage('Invalid PGN: ' + (error instanceof Error ? error.message : String(error)))
    }
  }, [invalidatePending, publishPosition])

  // Resign
  const resign = useCallback(() => {
    if (gameOver) return
    if (!window.confirm('Are you sure you want to resign?')) return

    setGameOver(true)
    if (playerColor === 'black') {
      setResult('1-0 (Black resigned)')
    } else {
      setResult('0-1 (White resigned)')
    }
  }, [gameOver, playerColor])

  // LLM vs LLM: Make a single LLM move
  const makeLlmMoveForBot = useCallback(async (
    currentGame: Chess,
    currentHistory: string[],
    config: BotConfig,
    turbo: boolean,
    signal: AbortSignal
  ): Promise<{ status: 'ok' | 'aborted' | 'error'; move?: string; from?: string; to?: string; captured?: boolean; telemetry?: MoveTelemetry; probabilities?: MoveProb[]; sourceFen?: string; sourcePgn?: string; error?: string }> => {
    const sourceFen = currentGame.fen()
    const sourcePgn = buildPgn(currentHistory)
    try {
      const response = await fetch(`${API_URL}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: sourceFen,
          pgn: sourcePgn,
          temperature: config.temperature,
          model: config.model,
          turbo: turbo,
          top_p: config.topP,
          top_k: config.topK,
          min_p: config.minP,
          stochastic: config.temperature > 0
        }),
        signal
      })
      const data = await response.json()
      signal.throwIfAborted()
      if (response.ok && data.success && data.move_san && currentGame.fen() === sourceFen) {
        const move = currentGame.move(data.move_san)
        return {
          status: 'ok',
          move: data.move_san,
          from: move.from,
          to: move.to,
          captured: !!move?.captured,
          telemetry: data.telemetry,
          probabilities: data.probabilities,
          sourceFen,
          sourcePgn,
        }
      }
      return { status: 'error', error: data.error ?? 'No legal move returned' }
    } catch (error) {
      if (signal.aborted) return { status: 'aborted' }
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }, [buildPgn])

  // LLM vs LLM: Run a single game
  const runLlmGame = useCallback(async (
    whiteConfig: BotConfig,
    blackConfig: BotConfig,
    startFen: string,
    seedPgn: string,
    turbo: boolean,
    delay: number,
    signal: AbortSignal
  ): Promise<{ result: '1-0' | '0-1' | '1/2-1/2' | 'aborted' | 'error'; pgn: string; error?: string }> => {
    const gameInstance = new Chess()
    if (seedPgn) gameInstance.loadPgn(seedPgn)
    if (gameInstance.fen() !== startFen) return { result: 'error', pgn: seedPgn, error: 'Position does not match PGN history; native ChessGPT requires a matching game.' }
    const history: string[] = gameInstance.history()
    const epoch = gameEpoch.current

    publishPosition(cloneWithHistory(gameInstance))
    setMoveRecords(history.map(san => ({ san, actor: 'unknown' as const })))
    setLastMove(null)

    while (!gameInstance.isGameOver() && !signal.aborted && epoch === gameEpoch.current) {
      // Wait if paused
      while (llmMatchPausedRef.current && !signal.aborted) {
        await new Promise(r => setTimeout(r, 100))
      }
      if (signal.aborted || epoch !== gameEpoch.current) break

      const isWhiteTurn = gameInstance.turn() === 'w'
      const config = isWhiteTurn ? whiteConfig : blackConfig

      const result = await makeLlmMoveForBot(gameInstance, history, config, turbo, signal)
      if (signal.aborted || epoch !== gameEpoch.current || result.status === 'aborted') {
        return { result: 'aborted', pgn: buildPgn(history) }
      }
      if (result.status === 'error') {
        return { result: 'error', pgn: buildPgn(history), error: result.error }
      }

      history.push(result.move!)

      // Update UI
      publishPosition(cloneWithHistory(gameInstance))
      const metadata = result.telemetry
      const validMetadata = metadata && metadata.source_fen === result.sourceFen &&
        metadata.source_pgn === result.sourcePgn && metadata.model === config.model &&
        metadata.temperature === config.temperature
      setMoveRecords(prev => [...prev.slice(0, history.length - 1), {
        san: result.move!, actor: 'engine' as const,
        telemetry: validMetadata ? metadata : undefined,
      }])
      if (validMetadata && result.sourceFen !== undefined && result.sourcePgn !== undefined) {
        cacheProbabilities(result.sourceFen, result.sourcePgn, config.model, config.temperature, result.probabilities ?? [])
      }
      if (result.from && result.to) {
        setLastMove({ from: result.from, to: result.to })
      }
      playSound(result.captured ? 'capture' : 'move', soundEnabled)

      // Custom delay for UI and rate limiting
      await new Promise(r => setTimeout(r, Math.max(50, delay)))
    }

    if (signal.aborted || epoch !== gameEpoch.current) {
      return { result: 'aborted', pgn: buildPgn(history) }
    }

    // Determine result
    let gameResult: '1-0' | '0-1' | '1/2-1/2' = '1/2-1/2'
    if (gameInstance.isCheckmate()) {
      gameResult = gameInstance.turn() === 'w' ? '0-1' : '1-0'
    }
    return { result: gameResult, pgn: buildPgn(history) }
  }, [makeLlmMoveForBot, buildPgn, soundEnabled, publishPosition, cacheProbabilities])

  // LLM vs LLM: Start a match
  const startLlmMatch = useCallback(async (
    whiteConfig: BotConfig,
    blackConfig: BotConfig,
    startFresh: boolean,
    alternateColors: boolean,
    turboEnabled: boolean,
    moveDelay: number
  ) => {
    const initialBoard = cloneWithHistory(currentGameRef.current)
    const startingFen = startFresh ? new Chess().fen() : initialBoard.fen()
    const seedPgn = startFresh ? '' : buildPgn(initialBoard.history())
    const replay = new Chess()
    try {
      if (seedPgn) replay.loadPgn(seedPgn)
      if (replay.fen() !== startingFen) throw new Error('The current position cannot be reconstructed from PGN.')
    } catch (error) {
      setErrorMessage((error instanceof Error ? error.message : String(error)) + ' Use a standard-start PGN for native ChessGPT.')
      return
    }
    invalidatePending()
    const matchEpoch = gameEpoch.current
    const abortController = new AbortController()
    setLlmMatchAbortController(abortController)
    setLlmWhiteConfig(whiteConfig)
    setLlmBlackConfig(blackConfig)
    setLlmMatchRunning(true)
    setLlmMatchPaused(false)
    setLlmMatchCurrentGame(1)
    setLlmMatchResults({ white: 0, black: 0, draws: 0 })
    setLlmMatchPgns([])
    setGameOver(false)
    setErrorMessage('')
    probsCacheRef.current.clear()
    setProbabilitiesVersion(v => v + 1)

    const numGamesToPlay = llmMatchTotalGames
    const allPgns: string[] = []
    const matchResults = { white: 0, black: 0, draws: 0 }
    let interrupted = false

    for (let g = 1; g <= numGamesToPlay; g++) {
      if (abortController.signal.aborted) break
      setLlmMatchCurrentGame(g)

      // Start position: if startFresh, use current board; otherwise use initial position
      // When startFresh is false (using custom position), ALL games use the same starting FEN
      // Alternate colors: if g is even, white/black configs are swapped
      const swap = alternateColors && (g % 2 === 0)
      const currentWhite = swap ? blackConfig : whiteConfig
      const currentBlack = swap ? whiteConfig : blackConfig
      setLlmWhiteConfig(currentWhite)
      setLlmBlackConfig(currentBlack)

      const result = await runLlmGame(
        currentWhite,
        currentBlack,
        startingFen,
        seedPgn,
        turboEnabled,
        moveDelay,
        abortController.signal
      )

      if (result.result === 'aborted') break
      if (result.result === 'error') {
        setErrorMessage('Match stopped without a scored result: ' + (result.error ?? 'Inference failed'))
        interrupted = true
        break
      }

      allPgns.push(result.pgn)
      setLlmMatchPgns([...allPgns])

      // Determine match point based on game result and color swap
      if (result.result === '1-0') {
        if (!swap) matchResults.white++
        else matchResults.black++
      } else if (result.result === '0-1') {
        if (!swap) matchResults.black++
        else matchResults.white++
      } else {
        matchResults.draws++
      }

      setLlmMatchResults({ ...matchResults })

      // Small delay between games
      if (g < numGamesToPlay) {
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    if (matchEpoch !== gameEpoch.current) return
    if (!abortController.signal.aborted && !interrupted && allPgns.length === numGamesToPlay) {
      setGameOver(true)
      setResult(`Match Finished: ${matchResults.white}-${matchResults.black} (${matchResults.draws} draws)`)
    }
    setLlmMatchRunning(false)
    setLlmMatchPaused(false)
    setLlmMatchAbortController(null)
  }, [runLlmGame, llmMatchTotalGames, buildPgn, invalidatePending])

  const pauseLlmMatch = useCallback(() => {
    setLlmMatchPaused(true)
  }, [])

  const resumeLlmMatch = useCallback(() => {
    setLlmMatchPaused(false)
  }, [])

  const stopLlmMatch = useCallback(() => {
    llmMatchAbortController?.abort()
    setLlmMatchRunning(false)
    setLlmMatchPaused(false)
    setErrorMessage('Match stopped; interrupted game was not scored.')
  }, [llmMatchAbortController])

  const changeMode = useCallback((nextMode: AppMode) => {
    if (nextMode === appMode) return
    if (llmMatchRunning) {
      llmMatchAbortController?.abort()
      setLlmMatchRunning(false)
      setLlmMatchPaused(false)
    }
    invalidatePending()
    setShowModal(false)
    setShowPgnImport(false)
    setAppMode(nextMode)
  }, [appMode, llmMatchRunning, llmMatchAbortController, invalidatePending])

  const exportPgn = useCallback(() => {
    const white = appMode === 'llm-vs-llm'
      ? llmWhiteConfig?.model ?? 'Unknown model'
      : appMode === 'analysis' ? 'Analysis' : playerColor === 'white' ? 'Human' : model
    const black = appMode === 'llm-vs-llm'
      ? llmBlackConfig?.model ?? 'Unknown model'
      : appMode === 'analysis' ? 'Analysis' : playerColor === 'black' ? 'Human' : model
    const outcome = result.startsWith('1-0') ? '1-0'
      : result.startsWith('0-1') ? '0-1'
      : result.startsWith('1/2-1/2') ? '1/2-1/2'
      : game.isCheckmate() ? game.turn() === 'w' ? '0-1' : '1-0'
      : game.isDraw() ? '1/2-1/2' : '*'
    const finalResult = gameOver ? outcome : '*'
    return `[Event "ChessLLM Game"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${finalResult}"]\n\n${pgn}${finalResult === '*' ? '' : ` ${finalResult}`}`
  }, [appMode, llmWhiteConfig, llmBlackConfig, playerColor, model, result, game, gameOver, pgn])

  return (
    <div className="app">
      <EngineStatus />
      <TopNav
        currentMode={appMode}
        onModeChange={changeMode}
        analysisOn={analysisMode}
        onAnalysisToggle={() => setAnalysisMode(!analysisMode)}
        turboOn={turboMode}
        onTurboToggle={() => setTurboMode(!turboMode)}
        thinkingOn={thinkingMode}
        onThinkingToggle={() => setThinkingMode(!thinkingMode)}
        hintsMode={hintsMode}
        onHintsModeChange={setHintsMode}
        showMaterial={showMaterial}
        onShowMaterialChange={setShowMaterial}
        boardTheme={boardTheme}
        onBoardThemeChange={setBoardTheme}
        soundEnabled={soundEnabled}
        onSoundEnabledChange={setSoundEnabled}
        showCheckHighlight={showCheckHighlight}
        onShowCheckHighlightChange={setShowCheckHighlight}
      />

      {/* Test page route */}
      {isTestPage && <MethodTest />}

      {/* Main app */}
      {!isTestPage && (appMode === 'tournament' ? (
        <TournamentView />
      ) : (
        <main className="main-container">
          <aside className="sidebar">
            <MoveHistory
              moves={moveHistory}
              records={moveRecords}
              viewingIndex={viewingMoveIndex}
              onNavigate={handleMoveNavigate}
            />
            <button className="import-pgn-trigger" onClick={() => setShowPgnImport(true)}>Import full PGN</button>
            {appMode === 'llm-vs-llm' ? (
              <LLMvsLLMPanel
                onStart={startLlmMatch}
                onPause={pauseLlmMatch}
                onResume={resumeLlmMatch}
                onStop={stopLlmMatch}
                onTotalGamesChange={_setLlmMatchTotalGames}
                isRunning={llmMatchRunning}
                isPaused={llmMatchPaused}
                currentGame={llmMatchCurrentGame}
                totalGames={llmMatchTotalGames}
                results={llmMatchResults}
                disabled={false}
              />
            ) : (
              <ControlPanel
                onNewGame={() => setShowModal(true)}
                onTakeback={takeback}
                onFlip={() => setIsFlipped(!isFlipped)}
                onAnalyze={analyzePosition}
                onResign={resign}
                temperature={temperature}
                onTemperatureChange={setTemperature}
                model={model}
                onModelChange={setModel}
                showOpponentPrediction={showOpponentPrediction}
                onShowOpponentPredictionChange={setShowOpponentPrediction}
                disabled={isThinking}
              />
            )}
          </aside>

          <section className="board-section">
            <div className="player-info top">
              <span className={`status ${isThinking ? 'thinking' : ''}`}>
                {isThinking ? '🤔' : ''}
              </span>
              <span>
                {appMode === 'analysis'
                  ? `Black ${analysisMode ? '(Analysis ON)' : ''}`
                  : appMode === 'llm-vs-llm' && llmBlackConfig
                    ? `${llmBlackConfig.model.charAt(0).toUpperCase() + llmBlackConfig.model.slice(1)} (t=${llmBlackConfig.temperature}${llmBlackConfig.topK > 0 ? ` k=${llmBlackConfig.topK}` : ''}${llmBlackConfig.topP < 1 ? ` p=${llmBlackConfig.topP}` : ''}${llmBlackConfig.minP > 0 ? ` min=${llmBlackConfig.minP}` : ''}) ⚫`
                    : `ChessLLM (${model})`}
              </span>
              {isThinking && thinkingMode && <span className="thinking-text">Inference running…</span>}
              {showMaterial && <MaterialCount fen={viewingFen} side={isFlipped ? 'white' : 'black'} />}
            </div>

            <ChessBoard
              fen={viewingFen}
              onMove={onMove}
              isFlipped={isFlipped}
              playerColor={playerColor}
              disabled={appMode === 'llm-vs-llm' || isThinking || gameOver || viewingMoveIndex !== null ||
                (appMode === 'play' && (game.turn() === 'w' ? 'white' : 'black') !== playerColor)}
              lastMove={viewingMoveIndex === null ? lastMove : null}
              allowBothSides={appMode === 'analysis'}
              hintsMode={hintsMode}
              boardTheme={boardTheme}
              isInCheck={showCheckHighlight && viewingMoveIndex === null && game.isCheck()}
            />

            {viewingMoveIndex !== null && (
              <div className="viewing-overlay">
                <button
                  className="btn btn-primary"
                  onClick={() => setViewingMoveIndex(null)}
                >
                  ↩ Return to current position
                </button>
              </div>
            )}

            <div className="player-info bottom">
              <span>
                {appMode === 'analysis'
                  ? `White ${analysisMode ? '(Analysis ON)' : ''}`
                  : appMode === 'llm-vs-llm' && llmWhiteConfig
                    ? `${llmWhiteConfig.model.charAt(0).toUpperCase() + llmWhiteConfig.model.slice(1)} (t=${llmWhiteConfig.temperature}${llmWhiteConfig.topK > 0 ? ` k=${llmWhiteConfig.topK}` : ''}${llmWhiteConfig.topP < 1 ? ` p=${llmWhiteConfig.topP}` : ''}${llmWhiteConfig.minP > 0 ? ` min=${llmWhiteConfig.minP}` : ''}) ⚪`
                    : `You (${playerColor})`}
              </span>
              {showMaterial && <MaterialCount fen={viewingFen} side={isFlipped ? 'black' : 'white'} />}
            </div>

            <div className="fen-pgn">
              <div className="fen-box">
                <label>FEN</label>
                <input readOnly value={viewingFen} onClick={e => (e.target as HTMLInputElement).select()} />
                <button title="Copy displayed FEN" onClick={() => navigator.clipboard.writeText(viewingFen)}>📋</button>
              </div>
              <div className="pgn-box">
                <label>PGN</label>
                <textarea readOnly value={pgn} onClick={e => (e.target as HTMLTextAreaElement).select()} />
                <button onClick={() => {
                  navigator.clipboard.writeText(exportPgn())
                }}>📋</button>
              </div>
            </div>
          </section>

          <aside className="analysis-panel">
            <StockfishAnalysis
              fen={viewingFen}
              history={moveHistory}
              viewingIndex={viewingMoveIndex}
              onNavigate={handleMoveNavigate}
            />
            <AnalysisPanel
              model={nextTurnConfig?.model ?? model}
              probabilities={moveProbabilities}
              opponentPrediction={lastOpponentPrediction}
              showOpponentPrediction={showOpponentPrediction}
              pgn={pgn}
              illegalMoves={illegalMoves}
              onSavePgn={() => {
                const pgnContent = exportPgn()
                const blob = new Blob([pgnContent], { type: 'application/x-chess-pgn' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `chessllm_game_${Date.now()}.pgn`
                a.click()
              }}
            />
          </aside>
        </main>
      ))}

      {!isTestPage && appMode !== 'tournament' && errorMessage && (
        <div className="app-error" role="alert">
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage('')} aria-label="Dismiss error">×</button>
        </div>
      )}

      {!isTestPage && appMode !== 'tournament' && showPgnImport && (
        <PgnImport onImport={importPgn} onClose={() => setShowPgnImport(false)} />
      )}

      {!isTestPage && appMode === 'play' && showModal && (
        <GameModal
          onStart={startGame}
          onClose={() => setShowModal(false)}
        />
      )}

      {!isTestPage && (appMode === 'play' || appMode === 'llm-vs-llm') && gameOver && (
        <div className="game-over-modal">
          <div className="modal-content">
            <h2>Game Over</h2>
            <p className="result">{result}</p>
            <div className="game-over-buttons">
              <button className="btn btn-primary" onClick={() => {
                setGameOver(false)
                setShowModal(true)
              }}>
                🔄 New Game
              </button>
              <button className="btn" onClick={() => {
                const pgnContent = exportPgn()
                const blob = new Blob([pgnContent], { type: 'application/x-chess-pgn' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `chessllm_game_${Date.now()}.pgn`
                a.click()
              }}>
                💾 Save PGN
              </button>
              <button className="btn" onClick={() => {
                navigator.clipboard.writeText(pgn)
                alert('PGN copied to clipboard!')
              }}>
                📋 Copy PGN
              </button>
              <button className="btn" onClick={() => setGameOver(false)}>
                👁 Review Game
              </button>
              <button className="btn" onClick={() => {
                const lichessUrl = `https://lichess.org/analysis/pgn/${encodeURIComponent(pgn)}`
                window.open(lichessUrl, '_blank')
              }}>
                🔗 Analyze on Lichess
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

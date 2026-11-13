import { useEffect, useRef } from 'react'
import { Chess } from 'chess.js'
import type { PlyRecord, MoveTelemetry } from '../lib/telemetry'
import './MoveHistory.css'

interface MoveHistoryProps {
    moves: string[]
    records?: (PlyRecord | undefined)[]
    viewingIndex: number | null  // null = viewing current position, number = viewing after move at that index
    onNavigate: (index: number | null) => void
}

const valueOrDash = (value: number | undefined | null, suffix = '', digits = 1) =>
    value === undefined || value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}${suffix}`

const probability = (value: number | undefined) => valueOrDash(value === undefined ? undefined : value * 100, '%', 2)

// Describes legal chess mechanics at the recorded source FEN, not a model explanation.
function moveFacts(san: string, telemetry: MoveTelemetry | undefined): string | undefined {
    if (!telemetry?.source_fen) return undefined
    try {
        const board = new Chess(telemetry.source_fen)
        const turn = board.turn() === 'w' ? 'White' : 'Black'
        const move = board.move(san)
        if (!move) return undefined
        const pieces: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
        const details = [`${turn} ${pieces[move.piece]} ${move.from} → ${move.to}`]
        if (move.flags.includes('k') || move.flags.includes('q')) details.push('castles')
        if (move.captured) details.push(`captures ${pieces[move.captured]}`)
        if (move.promotion) details.push(`promotes to ${pieces[move.promotion]}`)
        if (board.isCheckmate()) details.push('checkmate')
        else if (board.isCheck()) details.push('check')
        return details.join(' · ')
    } catch { return undefined }
}

export default function MoveHistory({ moves, records = [], viewingIndex, onNavigate }: MoveHistoryProps) {
    const movesContainerRef = useRef<HTMLDivElement>(null)

    // Group moves into pairs (white, black)
    const movePairs: { num: number; white: string; black?: string; whiteIdx: number; blackIdx?: number }[] = []

    for (let i = 0; i < moves.length; i += 2) {
        movePairs.push({
            num: Math.floor(i / 2) + 1,
            white: moves[i],
            black: moves[i + 1],
            whiteIdx: i,
            blackIdx: moves[i + 1] !== undefined ? i + 1 : undefined
        })
    }

    // The index we're actually viewing (defaults to last move if null)
    const effectiveIndex = viewingIndex !== null ? viewingIndex : moves.length - 1
    const selectedRecord = effectiveIndex >= 0 && records[effectiveIndex]?.san === moves[effectiveIndex]
        ? records[effectiveIndex] : undefined
    const telemetry = selectedRecord?.telemetry
    const selectedSan = moves[effectiveIndex]
    const facts = selectedSan ? moveFacts(selectedSan, telemetry) : undefined

    // Navigation handlers
    const goToStart = () => onNavigate(-1)  // -1 = starting position (before any moves)
    const goBack = () => {
        if (effectiveIndex >= 0) {
            onNavigate(effectiveIndex - 1)
        }
    }
    const goForward = () => {
        if (effectiveIndex < moves.length - 1) {
            onNavigate(effectiveIndex + 1)
        } else {
            onNavigate(null)  // Return to live position
        }
    }
    const goToEnd = () => onNavigate(null)

    // Keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return  // Don't interfere with text inputs
            }
            if (e.key === 'ArrowLeft') {
                e.preventDefault()
                if (effectiveIndex >= 0) onNavigate(effectiveIndex - 1)
            } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                onNavigate(effectiveIndex < moves.length - 1 ? effectiveIndex + 1 : null)
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                onNavigate(-1)
            } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                onNavigate(null)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [effectiveIndex, moves.length, onNavigate])

    // Auto-scroll to the current move
    useEffect(() => {
        if (movesContainerRef.current && viewingIndex === null && moves.length > 0) {
            movesContainerRef.current.scrollTop = movesContainerRef.current.scrollHeight
        }
    }, [moves.length, viewingIndex])

    const isViewingHistory = viewingIndex !== null

    return (
        <div className="move-history">
            <h3 className="sidebar-header">Move History</h3>

            {/* Navigation controls */}
            <div className="move-nav-controls">
                <button
                    className="nav-btn"
                    onClick={goToStart}
                    disabled={moves.length === 0 || effectiveIndex < 0}
                    title="Go to start (↑)"
                >
                    ⏮
                </button>
                <button
                    className="nav-btn"
                    onClick={goBack}
                    disabled={moves.length === 0 || effectiveIndex < 0}
                    title="Previous move (←)"
                >
                    ◀
                </button>
                <button
                    className="nav-btn"
                    onClick={goForward}
                    disabled={moves.length === 0 || viewingIndex === null}
                    title="Next move (→)"
                >
                    ▶
                </button>
                <button
                    className="nav-btn"
                    onClick={goToEnd}
                    disabled={moves.length === 0 || viewingIndex === null}
                    title="Go to current (↓)"
                >
                    ⏭
                </button>
            </div>

            {isViewingHistory && (
                <div className="viewing-history-banner">
                    👁️ Viewing move {effectiveIndex < 0 ? 'start' : effectiveIndex + 1} of {moves.length}
                </div>
            )}

            <div className="moves-container" ref={movesContainerRef}>
                {movePairs.length === 0 ? (
                    <p className="no-moves">No moves yet</p>
                ) : (
                    movePairs.map(pair => (
                        <div key={pair.num} className="move-row">
                            <span className="move-number">{pair.num}.</span>
                            <span
                                className={`move white-move ${effectiveIndex === pair.whiteIdx ? 'active' : ''}`}
                                onClick={() => onNavigate(pair.whiteIdx)}
                            >
                                {pair.white}
                            </span>
                            <span
                                className={`move black-move ${pair.blackIdx !== undefined && effectiveIndex === pair.blackIdx ? 'active' : ''}`}
                                onClick={() => pair.blackIdx !== undefined && onNavigate(pair.blackIdx)}
                            >
                                {pair.black || ''}
                            </span>
                        </div>
                    ))
                )}
            </div>
            {selectedSan && (
                <div className="move-telemetry" aria-label="Selected move measurements">
                    <div className="move-telemetry-heading">Move {effectiveIndex + 1}: {selectedSan}</div>
                    <p className="move-telemetry-caption">Measurements refer to the board before this move.</p>
                    <div className="move-metrics">
                        <span>Played by</span><strong>{selectedRecord?.actor === 'engine' ? 'Model' : selectedRecord?.actor === 'human' ? 'Human' : '—'}</strong>
                        <span>Model</span><strong>{telemetry?.model ?? '—'}</strong>
                        <span>Scoring mode</span><strong>{telemetry?.score_mode ?? '—'}</strong>
                        <span>Model P(move)</span><strong>{probability(telemetry?.model_probability)}</strong>
                        <span>Sampling P(move)</span><strong>{probability(telemetry?.sampling_probability)}</strong>
                        <span>Model entropy</span><strong>{valueOrDash(telemetry?.model_entropy_bits, ' bits', 2)}</strong>
                        <span>Sampling entropy</span><strong>{valueOrDash(telemetry?.sampling_entropy_bits, ' bits', 2)}</strong>
                        <span>Surprisal</span><strong>{valueOrDash(telemetry?.surprisal_bits, ' bits', 2)}</strong>
                        <span>Inference compute</span><strong>{valueOrDash(telemetry?.inference_ms, ' ms', 0)}</strong>
                        <span>Request elapsed</span><strong>{valueOrDash(telemetry?.request_ms, ' ms', 0)}</strong>
                        <span>Model forwards</span><strong>{valueOrDash(telemetry?.model_forwards, '', 0)}</strong>
                        <span>Cache hits</span><strong>{valueOrDash(telemetry?.cache_hits, '', 0)}</strong>
                    </div>
                    {facts && (
                        <p className="move-facts"><strong>Move facts (chess rules):</strong> {facts}</p>
                    )}
                </div>
            )}
        </div>
    )
}

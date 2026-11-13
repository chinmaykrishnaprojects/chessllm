import { useState } from 'react'
import './AnalysisPanel.css'

interface MoveProb {
    move?: string
    san?: string
    prob?: number
    probability?: number
}

interface IllegalMove {
    move: string
    context: string
}

interface AnalysisPanelProps {
    model?: string
    probabilities: MoveProb[]
    opponentPrediction: MoveProb[]
    showOpponentPrediction: boolean
    pgn: string
    onSavePgn?: () => void
    illegalMoves?: IllegalMove[]
}

export default function AnalysisPanel({
    model = 'stockfish',
    probabilities,
    opponentPrediction,
    showOpponentPrediction,
    pgn,
    onSavePgn,
    illegalMoves = []
}: AnalysisPanelProps) {
    const [displayCount, setDisplayCount] = useState(10)
    const [showIllegal, setShowIllegal] = useState(false)

    // 999 = All legal moves
    const displayOptions = [1, 3, 5, 10, 999]

    const cycleDisplayCount = (direction: 'up' | 'down') => {
        const currentIdx = displayOptions.indexOf(displayCount)
        if (direction === 'up' && currentIdx > 0) {
            setDisplayCount(displayOptions[currentIdx - 1])
        } else if (direction === 'down' && currentIdx < displayOptions.length - 1) {
            setDisplayCount(displayOptions[currentIdx + 1])
        }
    }

    const formatProbs = (probs: MoveProb[]) => {
        const sliced = displayCount === 999 ? probs : probs.slice(0, displayCount)
        return sliced.map((p, i) => {
            const move = p.move || p.san || '?'
            const prob = (p.prob ?? p.probability ?? 0) * 100
            return (
                <div key={i} className="prob-bar">
                    <div className="prob-header">
                        <span className="prob-move">{move}</span>
                        <span className="prob-value">{prob.toFixed(1)}%</span>
                    </div>
                    <div className="prob-track">
                        <div
                            className="prob-fill"
                            style={{ width: `${Math.min(prob, 100)}%` }}
                        />
                    </div>
                </div>
            )
        })
    }

    return (
        <div className="analysis-panel">
            <h3 className="sidebar-header">LLM Analysis</h3>

            <div className="analysis-section">
                <div className="section-header">
                    <h4 className="section-title">Move Predictions</h4>
                    {probabilities.length > 0 && (
                        <div className="display-controls">
                            <button
                                className="btn-compact"
                                onClick={() => cycleDisplayCount('up')}
                                disabled={displayCount === displayOptions[0]}
                            >▲</button>
                            <span className="display-count">{displayCount === 999 ? 'All' : displayCount}</span>
                            <button
                                className="btn-compact"
                                onClick={() => cycleDisplayCount('down')}
                                disabled={displayCount === displayOptions[displayOptions.length - 1]}
                            >▼</button>
                        </div>
                    )}
                </div>
                <div className="probs-scroll-container">
                    {probabilities.length > 0 ? (
                        formatProbs(probabilities)
                    ) : (
                        <p className="no-analysis">
                            Choose Analyze Position to score the displayed position.
                        </p>
                    )}
                </div>
            </div>

            {illegalMoves.length > 0 && (
                <div className="analysis-section illegal-section">
                    <button
                        className="section-toggle"
                        onClick={() => setShowIllegal(!showIllegal)}
                    >
                        {showIllegal ? '▼' : '▶'} Illegal Moves ({illegalMoves.length})
                    </button>
                    {showIllegal && (
                        <div className="illegal-moves-list">
                            {illegalMoves.map((m, i) => (
                                <div key={i} className="illegal-move-item">
                                    <span className="illegal-move">{m.move}</span>
                                    <span className="illegal-context">{m.context}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {showOpponentPrediction && opponentPrediction.length > 0 && (
                <div className="analysis-section opponent">
                    <h4 className="section-title">LLM's Prediction for You</h4>
                    <div className="probs-scroll-container">
                        {formatProbs(opponentPrediction)}
                    </div>
                </div>
            )}

            <div className="model-info">
                <h4 className="section-title">Model Info</h4>
                <p className="model-name">{model === 'lichess' ? 'Lichess-trained ChessGPT' : 'Stockfish-trained ChessGPT'}</p>
                <p className="model-detail">16 layers · ~50M parameters · runs in your browser</p>
            </div>

            <div className="lichess-link">
                <button
                    className="btn-lichess"
                    onClick={() => {
                        const lichessUrl = `https://lichess.org/analysis/pgn/${encodeURIComponent(pgn)}`
                        window.open(lichessUrl, '_blank')
                    }}
                >
                    🔗 Analyze on Lichess
                </button>
                {onSavePgn && (
                    <button
                        className="btn-lichess"
                        onClick={onSavePgn}
                        style={{ marginTop: '8px' }}
                    >
                        💾 Save PGN
                    </button>
                )}
            </div>
        </div>
    )
}

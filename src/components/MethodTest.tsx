import { chessFetch as fetch } from '../lib/recoveryApi'
import { useState } from 'react'
import { Chess } from 'chess.js'
import './MethodTest.css'

const API_URL = '/api'

interface MoveProb {
    move: string
    prob: number
}

interface MethodResult {
    time: number
    move: string
    probs: MoveProb[]
}

const renderProbs = (probs: MoveProb[]) => {
    const sorted = [...probs].sort((a, b) => b.prob - a.prob).slice(0, 15)
    const maxProb = sorted[0]?.prob || 1

    return sorted.map((p, i) => (
        <div key={i} className="prob-bar">
            <div className="prob-header">
                <span className="prob-move">{p.move}</span>
                <span className="prob-value">{(p.prob * 100).toFixed(1)}%</span>
            </div>
            <div className="prob-track">
                <div className="prob-fill" style={{ width: `${(p.prob / maxProb) * 100}%` }} />
            </div>
        </div>
    ))
}

const MethodCard = ({ title, result }: { title: string; result: MethodResult | null }) => (
    <div className="method-card">
        <h3>{title}</h3>
        {result ? (
            <>
                <div className="method-stats">
                    <div className="stat">
                        <span className="stat-value">{result.time}</span>
                        <span className="stat-label">ms</span>
                    </div>
                    <div className="stat">
                        <span className="stat-value">{result.move}</span>
                        <span className="stat-label">Move</span>
                    </div>
                </div>
                <div className="probs-list">{renderProbs(result.probs)}</div>
            </>
        ) : (
            <div className="no-data">Click a button to run</div>
        )}
    </div>
)


export default function MethodTest() {
    const [pgn, setPgn] = useState('1. e4 e5 2. Nf3')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [results, setResults] = useState<{
        oldTurbo: MethodResult | null
        newOptimized: MethodResult | null
        oldFull: MethodResult | null
    }>({ oldTurbo: null, newOptimized: null, oldFull: null })

    const callMethod = async (turboMode: 'old' | 'new' | 'off'): Promise<MethodResult> => {
        const position = new Chess()
        position.loadPgn(pgn)
        const start = performance.now()
        const res = await fetch(`${API_URL}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fen: position.fen(),
                pgn,
                temperature: 0.3,
                model: 'stockfish',
                turbo: turboMode !== 'off',
                turbo_mode: turboMode === 'old' ? 'old' : 'new'
            })
        })
        const data = await res.json()
        if (!res.ok || !data.success) throw new Error(data.error || 'Inference failed')
        return {
            time: Math.round(performance.now() - start),
            move: data.move_san || '-',
            probs: data.probabilities || []
        }
    }

    const runAll = async () => {
        setLoading(true)
        setError('')
        try {
        const [oldTurbo, newOptimized, oldFull] = await Promise.all([
            callMethod('old'),
            callMethod('new'),
            callMethod('off')
        ])
        setResults({ oldTurbo, newOptimized, oldFull })
        } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setLoading(false) }
    }

    const runSequential = async () => {
        setLoading(true)
        setError('')
        try {
        const oldTurbo = await callMethod('old')
        setResults(r => ({ ...r, oldTurbo }))
        const newOptimized = await callMethod('new')
        setResults(r => ({ ...r, newOptimized }))
        const oldFull = await callMethod('off')
        setResults(r => ({ ...r, oldFull }))
        } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
        finally { setLoading(false) }
    }

    return (
        <div className="method-test-page">
            <h1>⚡ Inference Method Comparison</h1>

            <div className="test-controls">
                <input
                    type="text"
                    className="fen-input"
                    value={pgn}
                    onChange={(e) => setPgn(e.target.value)}
                    placeholder="Enter PGN from the starting position"
                    aria-label="Benchmark PGN"
                />
                <div className="btn-row">
                    <button onClick={runAll} disabled={loading}>
                        {loading ? '...' : '🚀 Run All (Parallel)'}
                    </button>
                    <button onClick={runSequential} disabled={loading}>
                        {loading ? '...' : '⏱️ Run Sequential'}
                    </button>
                </div>
            </div>

            <div className="methods-grid">
                <MethodCard title="Turbo · first request" result={results.oldTurbo} />
                <MethodCard title="Turbo · repeated request" result={results.newOptimized} />
                <MethodCard title="Exact SAN scoring (no pruning)" result={results.oldFull} />
            </div>
            {error && <p role="alert">{error}</p>}
            <p>Use sequential requests for cache timing. Parallel requests share the same browser worker.</p>
        </div>
    )
}

import { useState } from 'react'
import './LLMvsLLMPanel.css'

interface BotConfig {
    model: 'stockfish' | 'lichess'
    temperature: number
    topP: number
    topK: number
    minP: number
}

interface LLMvsLLMPanelProps {
    onStart: (whiteConfig: BotConfig, blackConfig: BotConfig, startFresh: boolean, alternateColors: boolean, turboEnabled: boolean, moveDelay: number) => void
    onPause: () => void
    onResume: () => void
    onStop: () => void
    onTotalGamesChange: (total: number) => void
    isRunning: boolean
    isPaused: boolean
    currentGame: number
    totalGames: number
    results: { white: number; black: number; draws: number }
    disabled: boolean
}

const defaultConfig: BotConfig = {
    model: 'stockfish',
    temperature: 0.7,
    topP: 1.0,
    topK: 0,
    minP: 0.0
}

export default function LLMvsLLMPanel({
    onStart,
    onPause,
    onResume,
    onStop,
    isRunning,
    isPaused,
    currentGame,
    totalGames,
    results,
    onTotalGamesChange,
    disabled
}: LLMvsLLMPanelProps) {
    const [whiteConfig, setWhiteConfig] = useState<BotConfig>({ ...defaultConfig })
    const [blackConfig, setBlackConfig] = useState<BotConfig>({ ...defaultConfig, model: 'lichess' })
    const [numGames, setNumGames] = useState(1)
    const [startFresh, setStartFresh] = useState(false)
    const [alternateColors, setAlternateColors] = useState(false)
    const [turboEnabled, setTurboEnabled] = useState(true)
    const [moveDelay, setMoveDelay] = useState(0)
    const [showAdvanced, setShowAdvanced] = useState(false)

    const handleStart = () => {
        onStart(whiteConfig, blackConfig, startFresh, alternateColors, turboEnabled, moveDelay)
    }

    const renderBotConfig = (
        label: string,
        config: BotConfig,
        setConfig: (c: BotConfig) => void,
        emoji: string
    ) => (
        <div className="bot-config">
            <h4>{emoji} {label}</h4>

            <div className="setting-row">
                <label>Model</label>
                <select
                    value={config.model}
                    onChange={e => setConfig({ ...config, model: e.target.value as 'stockfish' | 'lichess' })}
                    disabled={isRunning}
                >
                    <option value="stockfish">Stockfish-trained ChessGPT</option>
                    <option value="lichess">Lichess-trained ChessGPT</option>
                </select>
            </div>

            <div className="setting-row">
                <label>Temperature: {config.temperature.toFixed(1)}</label>
                <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={config.temperature}
                    onChange={e => setConfig({ ...config, temperature: parseFloat(e.target.value) })}
                    disabled={isRunning}
                />
                <div className="temp-labels">
                    <span>Greedy</span>
                    <span>Random</span>
                </div>
            </div>

            {showAdvanced && (
                <div className="advanced-settings">
                    <div className="setting-row">
                        <label title="Nucleus sampling: only consider tokens with cumulative probability up to this value. 1.0 = no filtering.">
                            Top-P: {config.topP.toFixed(2)}
                        </label>
                        <input
                            type="range"
                            min="0.1"
                            max="1"
                            step="0.05"
                            value={config.topP}
                            onChange={e => setConfig({ ...config, topP: parseFloat(e.target.value) })}
                            disabled={isRunning}
                        />
                    </div>

                    <div className="setting-row">
                        <label title="Only consider the top K most likely tokens. 0 = disabled.">
                            Top-K: {config.topK}
                        </label>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={config.topK}
                            onChange={e => setConfig({ ...config, topK: parseInt(e.target.value) })}
                            disabled={isRunning}
                        />
                    </div>

                    <div className="setting-row">
                        <label title="Minimum probability threshold. Tokens below this are filtered out. 0 = disabled.">
                            Min-P: {config.minP.toFixed(2)}
                        </label>
                        <input
                            type="range"
                            min="0"
                            max="0.5"
                            step="0.01"
                            value={config.minP}
                            onChange={e => setConfig({ ...config, minP: parseFloat(e.target.value) })}
                            disabled={isRunning}
                        />
                    </div>
                </div>
            )}
        </div>
    )

    return (
        <div className="llm-vs-llm-panel">
            <h3 className="sidebar-header">LLM vs LLM</h3>

            <div className="bots-container">
                {renderBotConfig('White', whiteConfig, setWhiteConfig, '⚪')}
                {renderBotConfig('Black', blackConfig, setBlackConfig, '⚫')}
            </div>

            <button
                className="btn btn-text advanced-toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
            >
                {showAdvanced ? '▼ Hide' : '▶ Show'} Advanced Settings
            </button>

            <div className="match-settings">
                <div className="setting-row">
                    <label>Number of Games</label>
                    <input
                        type="number"
                        min="1"
                        max="100"
                        value={numGames}
                        onChange={e => {
                            const val = Math.max(1, parseInt(e.target.value) || 1)
                            setNumGames(val)
                            onTotalGamesChange(val)
                        }}
                        disabled={isRunning}
                    />
                </div>

                <div className="setting-row checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={startFresh}
                            onChange={e => setStartFresh(e.target.checked)}
                            disabled={isRunning}
                        />
                        Start from initial position
                    </label>
                </div>

                <div className="setting-row checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={alternateColors}
                            onChange={e => setAlternateColors(e.target.checked)}
                            disabled={isRunning}
                        />
                        Alternate colors between games
                    </label>
                </div>

                <div className="setting-row checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={turboEnabled}
                            onChange={e => setTurboEnabled(e.target.checked)}
                            disabled={isRunning}
                        />
                        Turbo Mode (faster, no probabilities)
                    </label>
                </div>

                <div className="setting-row">
                    <label>Move Delay: {moveDelay}ms</label>
                    <input
                        type="range"
                        min="0"
                        max="2000"
                        step="50"
                        value={moveDelay}
                        onChange={e => setMoveDelay(parseInt(e.target.value))}
                        disabled={isRunning}
                    />
                </div>
            </div>

            {isRunning && (
                <div className="match-progress">
                    <div className="progress-text">
                        Game {currentGame} of {totalGames}
                    </div>
                    <div className="score-display">
                        <span className="player-score white-score">
                            {whiteConfig.model.charAt(0).toUpperCase() + whiteConfig.model.slice(1)}: {results.white + results.draws * 0.5}
                        </span>
                        <span className="score-separator">—</span>
                        <span className="player-score black-score">
                            {blackConfig.model.charAt(0).toUpperCase() + blackConfig.model.slice(1)}: {results.black + results.draws * 0.5}
                        </span>
                    </div>
                    <div className="results-display secondary">
                        <span className="white-wins">W: {results.white}</span>
                        <span className="draws">D: {results.draws}</span>
                        <span className="black-wins">L: {results.black}</span>
                    </div>
                </div>
            )}

            <div className="control-buttons">
                {!isRunning ? (
                    <button
                        className="btn btn-primary"
                        onClick={handleStart}
                        disabled={disabled}
                    >
                        ▶️ Start Match
                    </button>
                ) : (
                    <>
                        {isPaused ? (
                            <button className="btn btn-primary" onClick={onResume}>
                                ▶️ Resume
                            </button>
                        ) : (
                            <button className="btn" onClick={onPause}>
                                ⏸️ Pause
                            </button>
                        )}
                        <button className="btn btn-danger" onClick={onStop}>
                            ⏹️ Stop
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}

export type { BotConfig }

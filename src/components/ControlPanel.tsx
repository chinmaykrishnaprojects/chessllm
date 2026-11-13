import './ControlPanel.css'

interface ControlPanelProps {
    onNewGame: () => void
    onTakeback: () => void
    onFlip: () => void
    onAnalyze: () => void
    onResign: () => void
    temperature: number
    onTemperatureChange: (temp: number) => void
    model: string
    onModelChange: (model: string) => void
    showOpponentPrediction: boolean
    onShowOpponentPredictionChange: (show: boolean) => void
    disabled: boolean
}

export default function ControlPanel({
    onNewGame,
    onTakeback,
    onFlip,
    onAnalyze,
    onResign,
    temperature,
    onTemperatureChange,
    model,
    onModelChange,
    showOpponentPrediction,
    onShowOpponentPredictionChange,
    disabled
}: ControlPanelProps) {
    return (
        <div className="control-panel">
            <h3 className="sidebar-header">Game Controls</h3>

            <div className="controls-section">
                <button className="btn btn-primary" onClick={onNewGame}>
                    🔄 New Game
                </button>
                <button className="btn" onClick={onTakeback} disabled={disabled}>
                    ↩️ Takeback
                </button>
                <button className="btn" onClick={onFlip}>
                    ↕️ Flip Board
                </button>
                <button className="btn" onClick={onAnalyze} disabled={disabled}>
                    🔍 Analyze Position
                </button>
                <button className="btn btn-resign" onClick={onResign} disabled={disabled}>
                    🏁 Resign
                </button>
            </div>

            <div className="settings-section">
                <h4 className="section-title">LLM Settings</h4>

                <div className="setting-row">
                    <label htmlFor="model-select">Model</label>
                    <select
                        id="model-select"
                        value={model}
                        onChange={e => onModelChange(e.target.value)}
                    >
                        <option value="stockfish">Stockfish-trained ChessGPT</option>
                        <option value="lichess">Lichess-trained ChessGPT</option>
                    </select>
                </div>

                <div className="setting-row">
                    <label htmlFor="temp-slider">
                        Temperature: {temperature.toFixed(1)}
                    </label>
                    <input
                        id="temp-slider"
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        value={temperature}
                        onChange={e => onTemperatureChange(parseFloat(e.target.value))}
                    />
                    <div className="temp-labels">
                        <span>Greedy</span>
                        <span>Random</span>
                    </div>
                </div>

                <div className="setting-row checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={showOpponentPrediction}
                            onChange={e => onShowOpponentPredictionChange(e.target.checked)}
                        />
                        Show LLM's prediction for your moves
                    </label>
                </div>
            </div>
        </div>
    )
}

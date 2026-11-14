import { useState, useRef, useEffect } from 'react'
import './TopNav.css'

export type AppMode = 'play' | 'analysis' | 'llm-vs-llm' | 'tournament'
export type HintsMode = 'off' | 'partial' | 'on'
export type BoardTheme = 'green' | 'brown' | 'blue' | 'purple'

interface TopNavProps {
    currentMode: AppMode
    onModeChange: (mode: AppMode) => void
    analysisOn: boolean
    onAnalysisToggle: () => void
    turboOn: boolean
    onTurboToggle: () => void
    thinkingOn: boolean
    onThinkingToggle: () => void
    hintsMode: HintsMode
    onHintsModeChange: (mode: HintsMode) => void
    showMaterial: boolean
    onShowMaterialChange: (show: boolean) => void
    boardTheme: BoardTheme
    onBoardThemeChange: (theme: BoardTheme) => void
    soundEnabled: boolean
    onSoundEnabledChange: (enabled: boolean) => void
    showCheckHighlight: boolean
    onShowCheckHighlightChange: (show: boolean) => void
}

export default function TopNav({ currentMode, onModeChange, analysisOn, onAnalysisToggle, turboOn, onTurboToggle, thinkingOn, onThinkingToggle, hintsMode, onHintsModeChange, showMaterial, onShowMaterialChange, boardTheme, onBoardThemeChange, soundEnabled, onSoundEnabledChange, showCheckHighlight, onShowCheckHighlightChange }: TopNavProps) {
    const [settingsOpen, setSettingsOpen] = useState(false)
    const settingsRef = useRef<HTMLDivElement>(null)

    // Close popup when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
                setSettingsOpen(false)
            }
        }
        if (settingsOpen) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [settingsOpen])

    const modes: { id: AppMode; label: string; icon: string; enabled: boolean }[] = [
        { id: 'play', label: 'Play', icon: '♟️', enabled: true },
        { id: 'analysis', label: 'Analysis', icon: '📊', enabled: true },
        { id: 'llm-vs-llm', label: 'LLM vs LLM', icon: '🤖', enabled: true },
        { id: 'tournament', label: 'Tournament', icon: '🏆', enabled: true },
    ]

    return (
        <nav className="top-nav">
            <div className="nav-brand">
                <span className="brand-icon">♟</span>
                <span className="brand-name">ChessLLM</span>
            </div>

            <div className="nav-tabs">
                {modes.map(mode => (
                    <button
                        key={mode.id}
                        className={`nav-tab ${currentMode === mode.id ? 'active' : ''} ${!mode.enabled ? 'disabled' : ''}`}
                        onClick={() => mode.enabled && onModeChange(mode.id)}
                        disabled={!mode.enabled}
                        title={!mode.enabled ? 'Coming soon' : mode.label}
                    >
                        <span className="tab-icon">{mode.icon}</span>
                        <span className="tab-label">{mode.label}</span>
                    </button>
                ))}
                <a className="nav-tab" href="/coach/" title="Review a game with Queen">
                    <span className="tab-icon">♛</span>
                    <span className="tab-label">Coach</span>
                </a>
            </div>

            <div className="nav-actions">
                <button
                    className={`thinking-toggle ${thinkingOn ? 'on' : ''}`}
                    onClick={onThinkingToggle}
                    title="Show or hide the active inference indicator; this does not change the model"
                >
                    <span className="toggle-indicator" />
                    <span className="toggle-label">Activity: <span className="toggle-state">{thinkingOn ? 'ON' : 'OFF'}</span></span>
                </button>
                <button
                    className={`turbo-toggle ${turboOn ? 'on' : ''}`}
                    onClick={onTurboToggle}
                    title={turboOn ? 'Turbo: pruned legal-SAN scoring (ON)' : 'Turbo OFF: exact legal-SAN scoring'}
                >
                    <span className="toggle-indicator" />
                    <span className="toggle-label">⚡ Turbo: <span className="toggle-state">{turboOn ? 'ON' : 'OFF'}</span></span>
                </button>
                <button
                    className={`analysis-toggle ${analysisOn ? 'on' : ''}`}
                    onClick={onAnalysisToggle}
                    title={analysisOn ? 'Analysis ON' : 'Analysis OFF'}
                >
                    <span className="toggle-indicator" />
                    <span className="toggle-label">Analysis: <span className="toggle-state">{analysisOn ? 'ON' : 'OFF'}</span></span>
                </button>

                {/* Settings gear button with popup */}
                <div className="settings-container" ref={settingsRef}>
                    <button
                        className={`settings-btn ${settingsOpen ? 'active' : ''}`}
                        onClick={() => setSettingsOpen(!settingsOpen)}
                        title="Settings"
                    >
                        ⚙️
                    </button>

                    {settingsOpen && (
                        <div className="settings-popup">
                            <div className="settings-popup-header">Settings</div>

                            <div className="settings-item">
                                <label>Show Legal Moves</label>
                                <div className="hints-slider">
                                    <button
                                        className={hintsMode === 'off' ? 'active' : ''}
                                        onClick={() => onHintsModeChange('off')}
                                        title="No move indicators when selecting pieces"
                                    >
                                        Off
                                    </button>
                                    <button
                                        className={hintsMode === 'partial' ? 'active' : ''}
                                        onClick={() => onHintsModeChange('partial')}
                                        title="Highlights possible squares (may include invalid moves in check)"
                                    >
                                        Partial
                                    </button>
                                    <button
                                        className={hintsMode === 'on' ? 'active' : ''}
                                        onClick={() => onHintsModeChange('on')}
                                        title="Highlights all legal moves accurately"
                                    >
                                        On
                                    </button>
                                </div>
                            </div>

                            <div className="settings-item">
                                <label>Show Material Count</label>
                                <div className="hints-slider">
                                    <button
                                        className={!showMaterial ? 'active' : ''}
                                        onClick={() => onShowMaterialChange(false)}
                                        title="Hide captured pieces display"
                                    >
                                        Off
                                    </button>
                                    <button
                                        className={showMaterial ? 'active' : ''}
                                        onClick={() => onShowMaterialChange(true)}
                                        title="Show captured pieces and point advantage"
                                    >
                                        On
                                    </button>
                                </div>
                            </div>

                            <div className="settings-item">
                                <label>Board Theme</label>
                                <div className="hints-slider theme-slider">
                                    <button
                                        className={boardTheme === 'green' ? 'active' : ''}
                                        onClick={() => onBoardThemeChange('green')}
                                        title="Lichess green (default)"
                                    >
                                        🟢
                                    </button>
                                    <button
                                        className={boardTheme === 'brown' ? 'active' : ''}
                                        onClick={() => onBoardThemeChange('brown')}
                                        title="Classic wood brown"
                                    >
                                        🟤
                                    </button>
                                    <button
                                        className={boardTheme === 'blue' ? 'active' : ''}
                                        onClick={() => onBoardThemeChange('blue')}
                                        title="Icy blue"
                                    >
                                        🔵
                                    </button>
                                    <button
                                        className={boardTheme === 'purple' ? 'active' : ''}
                                        onClick={() => onBoardThemeChange('purple')}
                                        title="Royal purple"
                                    >
                                        🟣
                                    </button>
                                </div>
                            </div>

                            <div className="settings-item">
                                <label>Sound</label>
                                <div className="hints-slider">
                                    <button
                                        className={!soundEnabled ? 'active' : ''}
                                        onClick={() => onSoundEnabledChange(false)}
                                        title="Mute all sounds"
                                    >
                                        Off
                                    </button>
                                    <button
                                        className={soundEnabled ? 'active' : ''}
                                        onClick={() => onSoundEnabledChange(true)}
                                        title="Play move sounds"
                                    >
                                        On
                                    </button>
                                </div>
                            </div>

                            <div className="settings-item">
                                <label>Check Highlight</label>
                                <div className="hints-slider">
                                    <button
                                        className={!showCheckHighlight ? 'active' : ''}
                                        onClick={() => onShowCheckHighlightChange(false)}
                                        title="No highlight when in check"
                                    >
                                        Off
                                    </button>
                                    <button
                                        className={showCheckHighlight ? 'active' : ''}
                                        onClick={() => onShowCheckHighlightChange(true)}
                                        title="Highlight king when in check"
                                    >
                                        On
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </nav>
    )
}

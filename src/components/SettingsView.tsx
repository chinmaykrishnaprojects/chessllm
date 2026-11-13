import './SettingsView.css'

interface SettingsViewProps {
    showLegalMoveHints: boolean
    onShowLegalMoveHintsChange: (show: boolean) => void
}

export default function SettingsView({ showLegalMoveHints, onShowLegalMoveHintsChange }: SettingsViewProps) {
    return (
        <div className="settings-view">
            <h2>Settings</h2>

            <section className="settings-section">
                <h3>Gameplay</h3>

                <div className="setting-item">
                    <label className="setting-label">
                        <input
                            type="checkbox"
                            checked={showLegalMoveHints}
                            onChange={e => onShowLegalMoveHintsChange(e.target.checked)}
                        />
                        <span className="setting-text">
                            <strong>Show legal move hints</strong>
                            <small>Display dots on valid squares when selecting a piece. Turn off for training mode.</small>
                        </span>
                    </label>
                </div>
            </section>
        </div>
    )
}

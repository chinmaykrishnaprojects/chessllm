import './GameModal.css'

interface GameModalProps {
    onStart: (color: 'white' | 'black' | 'random') => void
    onClose: () => void
}

export default function GameModal({ onStart, onClose }: GameModalProps) {
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <h2 className="modal-title">Start New Game</h2>
                <p className="modal-subtitle">Choose your side</p>

                <div className="color-options">
                    {/* White king for White */}
                    <button className="color-card" onClick={() => onStart('white')}>
                        <svg className="color-icon-svg" viewBox="0 0 45 45">
                            <g fill="none" fillRule="evenodd" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22.5 11.63V6M20 8h5" strokeLinejoin="miter" />
                                <path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="#fff" strokeLinecap="butt" strokeLinejoin="miter" />
                                <path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill="#fff" />
                                <path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" />
                            </g>
                        </svg>
                        <span className="color-name">White</span>
                        <span className="color-desc">You move first</span>
                    </button>

                    <button className="color-card random" onClick={() => onStart('random')}>
                        <span className="color-icon">🎲</span>
                        <span className="color-name">Random</span>
                        <span className="color-desc">Surprise me</span>
                    </button>

                    {/* Black king for Black */}
                    <button className="color-card" onClick={() => onStart('black')}>
                        <svg className="color-icon-svg" viewBox="0 0 45 45">
                            <g fill="none" fillRule="evenodd" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22.5 11.63V6" strokeLinejoin="miter" />
                                <path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="#000" strokeLinecap="butt" strokeLinejoin="miter" />
                                <path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill="#000" />
                                <path d="M20 8h5" strokeLinejoin="miter" />
                                <path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" stroke="#fff" />
                            </g>
                        </svg>
                        <span className="color-name">Black</span>
                        <span className="color-desc">LLM moves first</span>
                    </button>
                </div>
            </div>
        </div>
    )
}

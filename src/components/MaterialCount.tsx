import { useMemo } from 'react'
import './MaterialCount.css'

interface MaterialCountProps {
    fen: string
    side: 'white' | 'black'  // Which side's captured pieces to show
}

const PIECE_VALUES: Record<string, number> = {
    'p': 1, 'P': 1,
    'n': 3, 'N': 3,
    'b': 3, 'B': 3,
    'r': 5, 'R': 5,
    'q': 9, 'Q': 9,
}

const PIECE_ICONS: Record<string, string> = {
    'P': '♙', 'N': '♘', 'B': '♗', 'R': '♖', 'Q': '♕',
    'p': '♟', 'n': '♞', 'b': '♝', 'r': '♜', 'q': '♛',
}

interface CapturedData {
    whiteCaptured: string[]  // Pieces white has captured (black pieces)
    blackCaptured: string[]  // Pieces black has captured (white pieces)
    diff: number  // Positive = white ahead
}

function countCaptures(fen: string): CapturedData {
    const position = fen.split(' ')[0]

    const starting: Record<string, number> = {
        'P': 8, 'N': 2, 'B': 2, 'R': 2, 'Q': 1,
        'p': 8, 'n': 2, 'b': 2, 'r': 2, 'q': 1,
    }

    const current: Record<string, number> = {}
    for (const char of position) {
        if (char in starting) {
            current[char] = (current[char] || 0) + 1
        }
    }

    const whiteCaptured: string[] = []
    const blackCaptured: string[] = []
    let whitePoints = 0
    let blackPoints = 0

    for (const [piece, startCount] of Object.entries(starting)) {
        const currentCount = current[piece] || 0
        const captured = startCount - currentCount

        if (captured > 0) {
            const isWhitePiece = piece === piece.toUpperCase()
            for (let i = 0; i < captured; i++) {
                if (isWhitePiece) {
                    blackCaptured.push(piece)
                    blackPoints += PIECE_VALUES[piece]
                } else {
                    whiteCaptured.push(piece)
                    whitePoints += PIECE_VALUES[piece]
                }
            }
        }
    }

    return {
        whiteCaptured,
        blackCaptured,
        diff: whitePoints - blackPoints,
    }
}

export default function MaterialCount({ fen, side }: MaterialCountProps) {
    const data = useMemo(() => countCaptures(fen), [fen])

    const pieces = side === 'white' ? data.whiteCaptured : data.blackCaptured
    const showDiff = side === 'white' ? data.diff > 0 : data.diff < 0
    const diffVal = Math.abs(data.diff)

    if (pieces.length === 0 && !showDiff) return null

    return (
        <span className="material-inline">
            <span className="captured-icons">
                {pieces.map((p, i) => (
                    <span key={i} className="piece-icon">{PIECE_ICONS[p]}</span>
                ))}
            </span>
            {showDiff && diffVal > 0 && (
                <span className="diff-badge">+{diffVal}</span>
            )}
        </span>
    )
}

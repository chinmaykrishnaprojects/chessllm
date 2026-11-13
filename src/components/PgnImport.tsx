import { useState } from 'react'
import './PgnImport.css'

interface PgnImportProps {
    onImport: (pgn: string) => void
    onClose: () => void
}

export default function PgnImport({ onImport, onClose }: PgnImportProps) {
    const [pgnText, setPgnText] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [error, setError] = useState('')

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0]
        if (selectedFile) {
            setFile(selectedFile)
            const reader = new FileReader()
            reader.onload = (event) => {
                const content = event.target?.result as string
                setPgnText(content)
            }
            reader.readAsText(selectedFile)
        }
    }

    const handleImport = () => {
        const trimmed = pgnText.trim()
        if (!trimmed) {
            setError('Please paste a PGN or upload a file')
            return
        }

        // Basic PGN validation
        if (!trimmed.includes('.') || trimmed.length < 5) {
            setError('Invalid PGN format')
            return
        }

        onImport(trimmed)
    }

    return (
        <div className="pgn-import-overlay">
            <div className="pgn-import-modal">
                <div className="pgn-import-header">
                    <h2>Import Game</h2>
                    <button className="close-btn" onClick={onClose}>×</button>
                </div>

                <p className="pgn-import-description">
                    Paste a game PGN to analyze with LLM log-likelihoods.
                </p>

                <div className="pgn-input-section">
                    <label>Paste the PGN text here</label>
                    <textarea
                        value={pgnText}
                        onChange={(e) => {
                            setPgnText(e.target.value)
                            setError('')
                        }}
                        placeholder="1. e4 e5 2. Nf3 Nc6 3. Bb5 ..."
                        rows={8}
                    />
                </div>

                <div className="pgn-file-section">
                    <label>Or upload a PGN file</label>
                    <input
                        type="file"
                        accept=".pgn,.txt"
                        onChange={handleFileChange}
                    />
                    {file && <span className="file-name">{file.name}</span>}
                </div>

                {error && <div className="pgn-error">{error}</div>}

                <div className="pgn-import-actions">
                    <button className="btn btn-primary" onClick={handleImport}>
                        📊 Import & Analyze
                    </button>
                </div>
            </div>
        </div>
    )
}

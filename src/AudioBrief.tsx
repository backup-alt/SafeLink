import { useState } from 'react'
import { Volume2 } from 'lucide-react'

type Language = 'en' | 'ta' | 'hi'

interface AudioBriefProps {
  englishText: string
  tamilText: string
  hindiText: string
}

export default function AudioBrief({
  englishText,
  tamilText,
  hindiText,
}: AudioBriefProps) {
  const [language, setLanguage] = useState<Language>('en')
  const [loading, setLoading] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  function getText() {
    if (language === 'ta') return tamilText
    if (language === 'hi') return hindiText
    return englishText
  }

  async function generateAudio() {
    try {
      setLoading(true)

      const response = await fetch('/api/audio-brief', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: getText(),
          language,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to generate audio')
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)

      setAudioUrl(url)
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        marginTop: '12px',
        paddingTop: '10px',
        borderTop: '1px solid rgba(255,255,255,0.12)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginBottom: '8px',
          fontSize: '11px',
          color: '#9db0b4',
        }}
      >
        <Volume2 size={15} />
        Audio Brief
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => {
            setLanguage('en')
            setAudioUrl(null)
          }}
          style={{
            padding: '5px 9px',
            borderRadius: '5px',
            border: '1px solid #53d9d6',
            background: language === 'en' ? '#19343c' : 'transparent',
            color: '#d8ffff',
            cursor: 'pointer',
            fontSize: '10px',
          }}
        >
          English
        </button>

        <button
          type="button"
          onClick={() => {
            setLanguage('ta')
            setAudioUrl(null)
          }}
          style={{
            padding: '5px 9px',
            borderRadius: '5px',
            border: '1px solid #53d9d6',
            background: language === 'ta' ? '#19343c' : 'transparent',
            color: '#d8ffff',
            cursor: 'pointer',
            fontSize: '10px',
          }}
        >
          தமிழ்
        </button>

        <button
          type="button"
          onClick={() => {
            setLanguage('hi')
            setAudioUrl(null)
          }}
          style={{
            padding: '5px 9px',
            borderRadius: '5px',
            border: '1px solid #53d9d6',
            background: language === 'hi' ? '#19343c' : 'transparent',
            color: '#d8ffff',
            cursor: 'pointer',
            fontSize: '10px',
          }}
        >
          हिन्दी
        </button>

        <button
          type="button"
          onClick={generateAudio}
          disabled={loading}
          style={{
            padding: '5px 10px',
            borderRadius: '5px',
            border: '1px solid #53d9d6',
            background: '#19343c',
            color: '#d8ffff',
            cursor: loading ? 'default' : 'pointer',
            fontSize: '10px',
          }}
        >
          {loading ? 'Generating...' : '▶ Play'}
        </button>
      </div>

      {audioUrl && (
        <audio
          controls
          autoPlay
          src={audioUrl}
          style={{ width: '100%', marginTop: '8px', height: '32px' }}
        />
      )}
    </div>
  )
}
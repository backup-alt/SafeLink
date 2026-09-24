from io import BytesIO

from gtts import gTTS


LANGUAGES = {
    "en": "en",
    "ta": "ta",
    "hi": "hi",
}


def translate_text(text: str, language: str) -> str:
    return text


def create_audio(text: str, language: str) -> BytesIO:
    if language not in LANGUAGES:
        raise ValueError("Unsupported language")

    audio = BytesIO()

    tts = gTTS(
        text=text,
        lang=LANGUAGES[language],
        slow=False
    )

    tts.write_to_fp(audio)
    audio.seek(0)

    return audio
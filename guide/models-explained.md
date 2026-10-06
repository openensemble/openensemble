# Which model does what

OE uses different models for different jobs. Connecting a chat provider is
enough for a first conversation; the other choices can wait.

| Job | Model or service | Where to configure it |
|---|---|---|
| Answer messages and use tools | Each agent's chat model | **Settings → Agents**, or the agent editor |
| Memory retrieval and small internal decisions | Cortex reasoning and embedding models | **Settings → System**; see [Cortex](cortex.md) |
| Interpret scheduling requests | Built-in plan model, or the agent model when disabled | **Settings → System → Scheduler Model** |
| Learn patterns and prepare private drafts | Personalization reflection model | **Settings → Personalization** |
| Analyze images and receipts | Vision-capable model | **Settings → Profile → Vision model** |
| Turn recorded speech into text | Speech-to-text (STT) | **Settings → Providers → Speech-to-Text** |
| Speak an answer | Text-to-speech (TTS) | **Settings → Providers → Text-to-Speech** |

Providers and system settings require owner/admin access. An administrator
controls which models a regular user may select.

## Your chat model

Enable one provider in Settings, then select one of its models for your
assistant. Choose a cloud API/account connection or your own Ollama/LM Studio
server. Provider access and a model selection are both needed.

The bundled Cortex models do not replace this choice. They perform internal
work such as retrieval and classification; they are not your ready-made chat
assistant. See [LLM providers](providers.md).

## Personalization is a separate choice

**Same as coordinator** uses the coordinator's configured model. Selecting a
specific reflection model can put this work on a different provider. Read the
privacy line beside that choice. **Off** pauses model-driven reflection;
**Learn about me** controls whether new observations are collected and learned
facts are used. See [Personalization](personalization.md#turning-it-off).

## A voice request uses three stages

1. STT transcribes the recording.
2. Your chat model receives the transcript and prepares an answer.
3. TTS turns the reply text into speech.

Each stage has its own configuration. Working chat does not prove that STT or
TTS is ready. Test them through [Voice diagnostics](voice-devices.md#voice-diagnostics).

## Local and cloud data flow

| Choice | What crosses the server boundary |
|---|---|
| Cloud chat | The conversation context, memories, attachments, and tool results included in that model request |
| Cloud STT | The recording submitted for transcription |
| Cloud TTS | The text submitted for speech generation |
| Cloud personalization | The bounded context described in [Personalization](personalization.md) |
| Local service on the OE machine | That model's processing stays on the machine |
| Model server on another LAN machine | Requests travel to that machine over your network |

For local voice processing, configure local STT, a local chat provider, and
local TTS. Check personalization and any connected services separately.
Downloading local models initially still requires access to their download
sources. Cortex uses local inference by default; alternate endpoints follow
the address you configure.

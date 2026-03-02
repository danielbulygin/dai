import { AssemblyAI } from 'assemblyai';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

let client: AssemblyAI | null = null;

function getClient(): AssemblyAI {
  if (!client) {
    if (!env.ASSEMBLYAI_API_KEY) {
      throw new Error('ASSEMBLYAI_API_KEY is not configured');
    }
    client = new AssemblyAI({ apiKey: env.ASSEMBLYAI_API_KEY });
  }
  return client;
}

const AUDIO_MIMETYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'audio/mp3',
]);

// Slack voice messages use "audio/webm" and have subtype "voice_message" on the file
const MAX_FILE_SIZE_MB = 25;

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
  subtype?: string;
}

export function isAudioFile(file: SlackFile): boolean {
  return AUDIO_MIMETYPES.has(file.mimetype) || file.subtype === 'voice_message';
}

export async function transcribeSlackAudio(
  file: SlackFile,
  botToken: string,
): Promise<string | null> {
  const sizeMb = file.size / (1024 * 1024);
  if (sizeMb > MAX_FILE_SIZE_MB) {
    logger.warn({ file: file.name, sizeMb }, 'Audio file too large, skipping transcription');
    return null;
  }

  logger.info({ file: file.name, mimetype: file.mimetype, sizeMb: sizeMb.toFixed(1) }, 'Transcribing voice note');

  // Download from Slack (private URL requires auth)
  const response = await fetch(file.url_private, {
    headers: { Authorization: `Bearer ${botToken}` },
  });

  if (!response.ok) {
    logger.error({ status: response.status, file: file.name }, 'Failed to download audio from Slack');
    return null;
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Transcribe via AssemblyAI
  const aai = getClient();
  const transcript = await aai.transcripts.transcribe({
    audio: audioBuffer,
    speaker_labels: false,
    language_detection: true,
  });

  if (transcript.status === 'error') {
    logger.error({ error: transcript.error, file: file.name }, 'AssemblyAI transcription failed');
    return null;
  }

  const text = transcript.text?.trim();
  if (!text) {
    logger.warn({ file: file.name }, 'Transcription returned empty text');
    return null;
  }

  logger.info(
    { file: file.name, chars: text.length, language: transcript.language_code },
    'Voice note transcribed',
  );

  return text;
}

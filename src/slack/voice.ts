import type { WebClient } from '@slack/web-api';
import { isAudioFile, transcribeSlackAudio, type SlackFile } from '../audio/transcribe.js';
import { logger } from '../utils/logger.js';
import { env } from '../env.js';

/**
 * Check a Slack message's files[] for audio, transcribe if found.
 * Returns the transcribed text, or null if no audio files.
 */
export async function transcribeAudioFiles(
  files: Array<Record<string, unknown>> | undefined,
  client: WebClient,
): Promise<string | null> {
  if (!files?.length) return null;
  if (!env.ASSEMBLYAI_API_KEY) return null;

  const audioFiles = files
    .map(
      (f) =>
        ({
          id: f.id as string,
          name: f.name as string,
          mimetype: f.mimetype as string,
          size: f.size as number,
          url_private: f.url_private as string,
          url_private_download: f.url_private_download as string | undefined,
          subtype: f.subtype as string | undefined,
        }) satisfies SlackFile,
    )
    .filter(isAudioFile);

  if (!audioFiles.length) return null;

  // Use the bot's own token for file downloads (requires files:read scope)
  const downloadToken = (client as unknown as { token: string }).token;

  if (!downloadToken) {
    logger.warn('No token available for audio download');
    return null;
  }

  logger.info(
    { count: audioFiles.length, files: audioFiles.map((f) => f.name) },
    'Voice note detected, transcribing',
  );

  // Transcribe all audio files (usually just one voice note)
  const transcripts: string[] = [];
  for (const file of audioFiles) {
    try {
      const text = await transcribeSlackAudio(file, downloadToken);
      if (text) transcripts.push(text);
    } catch (err) {
      logger.error({ err, file: file.name }, 'Voice note transcription failed');
    }
  }

  return transcripts.length > 0 ? transcripts.join('\n\n') : null;
}

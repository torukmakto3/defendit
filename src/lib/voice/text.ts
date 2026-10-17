import type { VoiceProvider, VoiceSessionConfig } from "./types";

/** Default text interview provider — full flow works without mic APIs. */
export const textVoiceProvider: VoiceProvider = {
  id: "text",
  modality: "text",
  async createSession(config: VoiceSessionConfig) {
    return {
      sessionHandle: `text:${config.sessionId}`,
    };
  },
};

/**
 * Voice provider adapter surface.
 * Text interview is the default MVP path; ElevenLabs Agents or OpenAI Realtime
 * can implement this interface later without rewriting session orchestration.
 */
export type InterviewModality = "text" | "voice";

export interface VoiceSessionConfig {
  sessionId: string;
  systemPrompt: string;
  /** Pre-sampled questions — drawn in code, passed in as dynamic variables */
  questionPlan: string[];
  silenceTimeoutMs: number;
  voicePreset?: string;
}

export interface VoiceTranscriptEvent {
  role: "assistant" | "user";
  text: string;
  at: string;
}

export interface VoiceProvider {
  id: "text" | "elevenlabs" | "openai-realtime";
  modality: InterviewModality;
  /** Start a realtime session; returns a connection handle / client secrets */
  createSession(config: VoiceSessionConfig): Promise<{
    sessionHandle: string;
    clientToken?: string;
  }>;
  /** Optional: end and fetch final transcript */
  finalizeSession?(sessionHandle: string): Promise<VoiceTranscriptEvent[]>;
}

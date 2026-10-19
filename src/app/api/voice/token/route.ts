import { AccessToken, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { handleError, jsonError, requireUser } from "@/lib/http";

export const runtime = "nodejs";

export const AGENT_NAME = "defend-it-interviewer";
const schema = z.object({ sessionId: z.string().min(1).max(64) });

/**
 * Join token for the creator's own voice defense. The room is named after the
 * session and the token dispatches the interviewer agent with the session id,
 * so the agent learns which defense it runs from LiveKit, not from the browser.
 */
export async function POST(req: Request) {
  const guard = await requireUser(req);
  if (guard.response) return guard.response;
  try {
    const { sessionId } = schema.parse(await req.json());
    const db = await getDb();
    const s = await db.get<{ user_id: string; channel: string; status: string; mode: string }>(
      `SELECT user_id, channel, status, mode FROM sessions WHERE id = ?`,
      [sessionId],
    );
    if (!s || s.user_id !== guard.user.id || s.mode !== "defend") return jsonError(404, "Defense not found");
    if (s.channel !== "voice") return jsonError(409, "This defense is not a voice interview.");
    if (s.status !== "in_progress") return jsonError(409, "This defense is already complete.");
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return jsonError(503, "Voice interviews are not configured.");

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: guard.user.id, ttl: "20m" });
    const room = `defend-${sessionId}`;
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify({ sessionId }) })],
    });
    return NextResponse.json({ url: LIVEKIT_URL, token: await at.toJwt(), room });
  } catch (e) {
    return handleError(e, "Could not start the voice interview");
  }
}

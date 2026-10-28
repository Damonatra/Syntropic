import { NextResponse } from 'next/server';
import { ensureDb } from '@/lib/ensure-db';

export const dynamic = 'force-dynamic';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * GET /api/rtc/config — ICE servers for the built-in WebRTC rooms (R-07).
 *
 * STUN is always on. When TURN_URL + TURN_USERNAME + TURN_CREDENTIAL are set
 * (env or .env), the room upgrades from local/STUN to a relay-capable
 * connection so clients behind symmetric NATs and strict corporate firewalls
 * can still join. TURN_URL accepts a comma-separated list (turns:, turn:).
 *
 * Without TURN env the room stays fully functional on STUN — this is the
 * same honest guard pattern as the Telegram dispatch (R-05).
 */
export async function GET() {
  await ensureDb();
  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;

  const iceServers: IceServerConfig[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  const turnConfigured = Boolean(TURN_URL && TURN_USERNAME && TURN_CREDENTIAL);
  if (turnConfigured) {
    iceServers.push({
      urls: TURN_URL!.split(',').map((s) => s.trim()).filter(Boolean),
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL,
    });
  }

  return NextResponse.json({
    iceServers,
    turnConfigured,
    mode: turnConfigured ? 'live' : 'local',
  });
}

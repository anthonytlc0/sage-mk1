import type { Controller } from '../../control/controller';

/** What the edit screens ask of the engine status. All of them read "nothing is going on" before the first status arrives. */

/** Any track recording, playing or overdubbing: the operations that Owner's Manual p. 23 refuses with STOP LOOPER / STOP ALL. */
export function looperRunning(ctx: Controller): boolean {
  const tracks = ctx.status?.tracks;
  if (!tracks) return false;
  for (const t of tracks) if (t.state === 'recording' || t.state === 'playing' || t.state === 'overdubbing') return true;
  return false;
}

/** The rhythm is playing (a rhythm that only waits to start, 'standby', is not). */
export function rhythmPlaying(ctx: Controller): boolean {
  return ctx.status?.rhythm === 'on';
}

/** Any track holds a phrase, stopped or not. */
export function tracksHaveAudio(ctx: Controller): boolean {
  const tracks = ctx.status?.tracks;
  if (!tracks) return false;
  for (const t of tracks) if (t.state !== 'empty') return true;
  return false;
}

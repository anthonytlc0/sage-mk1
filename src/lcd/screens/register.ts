import { registerScreen } from '../menu';
import { loopScreen } from './loop';
import { rhythmScreen } from './rhythm';
import { trackScreen } from './track';
import { writeScreen } from './write';

/**
 * Plugs the memory-editing screens into the menu system (Task 20): WRITE / CLEAR (EXIT + ENTER), TRACK (the TRACK
 * button), LOOP (the LOOP button) and RHYTHM (the RHYTHM [EDIT] button). The app calls this once at start-up; the
 * returned function takes them out again (tests use it to clean up).
 */
export function registerEditScreens(): () => void {
  const offs = [
    registerScreen('write', (_req, _ctx, menu) => writeScreen(menu)),
    registerScreen('track', (req) => trackScreen(req.track)),
    registerScreen('loop', () => loopScreen()),
    registerScreen('rhythmEdit', () => rhythmScreen()),
  ];
  return () => {
    for (const off of offs) off();
  };
}

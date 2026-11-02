import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppCommand } from '../shared/types';

type Options = {
  liveVoice: boolean;
  sessionActive: boolean;
  onSessionPage: boolean;
  request: (command: AppCommand) => Promise<boolean>;
  showSession: () => void;
};

/** The user's mic choice survives transport recovery, but never an intentional pause or page exit. */
export function useSessionMicrophone({
  liveVoice,
  sessionActive,
  onSessionPage,
  request,
  showSession,
}: Options) {
  const [requested, setRequested] = useState(false);
  const intentRevision = useRef(0);
  const previous = useRef({ liveVoice, sessionActive, onSessionPage });

  useEffect(() => {
    if (!liveVoice || !sessionActive || !onSessionPage) setRequested(false);
    if (
      (previous.current.liveVoice && !liveVoice) ||
      (previous.current.sessionActive && !sessionActive) ||
      (previous.current.onSessionPage && !onSessionPage)
    ) {
      intentRevision.current++;
    }
    previous.current = { liveVoice, sessionActive, onSessionPage };
  }, [liveVoice, sessionActive, onSessionPage]);

  const requestWithMicrophone = useCallback(
    async (command: AppCommand) => {
      let attempt = intentRevision.current;
      if (command.type === 'start-session') {
        attempt = ++intentRevision.current;
        showSession();
      } else if (command.type === 'pause-session') {
        intentRevision.current++;
        setRequested(false);
      }
      const succeeded = await request(command);
      if (succeeded && command.type === 'start-session' && attempt === intentRevision.current) {
        setRequested(liveVoice);
      }
      return succeeded;
    },
    [liveVoice, request, showSession],
  );

  const chooseMicrophone = useCallback((enabled: boolean) => {
    intentRevision.current++;
    setRequested(enabled);
  }, []);

  return { requested, setRequested: chooseMicrophone, request: requestWithMicrophone };
}

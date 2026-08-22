"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { emptyPersona, type Persona } from "@/lib/persona";

/**
 * 페르소나 보관소.
 *
 * `sessionStorage`만 쓴다. 탭을 닫으면 사라지고 서버에 저장되지 않는다.
 * 첫 화면이 "개인정보를 저장하지 않고 현재 대화의 맥락으로만 활용합니다"라고
 * 약속하므로 구현도 그 약속을 지켜야 한다.
 */

const KEY = "gb.persona";

interface PersonaContextValue {
  persona: Persona;
  setPersona: (next: Persona) => void;
  ready: boolean;
}

const PersonaContext = createContext<PersonaContextValue>({
  persona: emptyPersona,
  setPersona: () => undefined,
  ready: false
});

export function PersonaProvider({ children }: { children: React.ReactNode }) {
  const [persona, setPersonaState] = useState<Persona>(emptyPersona);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(KEY);
      if (stored) setPersonaState({ ...emptyPersona, ...JSON.parse(stored) });
    } catch {
      // 저장소를 못 읽어도 화면은 빈 페르소나로 동작한다.
    }
    setReady(true);
  }, []);

  const value = useMemo<PersonaContextValue>(
    () => ({
      persona,
      ready,
      setPersona: (next) => {
        setPersonaState(next);
        try {
          sessionStorage.setItem(KEY, JSON.stringify(next));
        } catch {
          // 무시: 맥락은 메모리에 남아 있다.
        }
      }
    }),
    [persona, ready]
  );

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

export function usePersona(): PersonaContextValue {
  return useContext(PersonaContext);
}

"use client";

import { useEffect, useState } from "react";

export const PALETTES = [
  { id: "cobalt", name: "Cobalt", note: "The default board blue", ground: "#0e3a86", board: "#f3e8d2", gold: "#f8b616" },
  { id: "bottle", name: "Bottle Green", note: "Sweet shops and chemists", ground: "#0c3b2a", board: "#f1ead1", gold: "#f2c33c" },
  { id: "sindoor", name: "Sindoor", note: "Wedding red, turquoise signal", ground: "#8a1d12", board: "#f6ead3", gold: "#f7c21d" },
  { id: "ink", name: "Ink & Gold", note: "Jewellers' lettering", ground: "#16150f", board: "#f4ecd8", gold: "#e2b23a" },
  { id: "peacock", name: "Peacock", note: "Older Bombay and Gulf boards", ground: "#0a5e66", board: "#f3ecd9", gold: "#f6c53e" },
  { id: "aubergine", name: "Aubergine", note: "Salon and parlour boards", ground: "#40194f", board: "#f4e9da", gold: "#f3c04a" },
] as const;

export type PaletteId = (typeof PALETTES)[number]["id"];
const STORAGE_KEY = "board-colour";

export function PaletteSwitcher() {
  const [active, setActive] = useState<PaletteId>("ink");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const current = document.documentElement.dataset.palette as PaletteId | undefined;
    if (current && PALETTES.some((p) => p.id === current)) setActive(current);
  }, []);

  function choose(id: PaletteId) {
    setActive(id);
    document.documentElement.dataset.palette = id;
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private window or blocked storage: the choice still applies for this visit */
    }
  }

  const current = PALETTES.find((p) => p.id === active) ?? PALETTES[3];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-end sm:px-5 sm:pb-5">
      <div className="panel pointer-events-auto flex max-w-full items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="board-colours"
          className="font-display shrink-0 text-xs uppercase tracking-[0.12em] text-ink/70 underline decoration-2 underline-offset-4 transition-colors hover:text-ink sm:text-[0.7rem]"
        >
          Board colour
        </button>

        <div
          id="board-colours"
          role="group"
          aria-label="Board colour"
          className="flex items-center gap-1.5"
        >
          {PALETTES.map((p) => {
            const on = p.id === active;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => choose(p.id)}
                aria-pressed={on}
                title={`${p.name} — ${p.note}`}
                className={`relative h-8 w-8 shrink-0 border-2 transition-transform duration-150 ease-out hover:-translate-y-0.5 ${
                  on ? "border-ink" : "border-ink/25"
                }`}
                style={{ background: p.ground }}
              >
                <span className="sr-only">
                  {p.name}. {p.note}.
                </span>
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-2"
                  style={{ background: p.gold }}
                />
                {on && (
                  <span
                    aria-hidden="true"
                    className="absolute -inset-[5px] border-2"
                    style={{ borderColor: p.board }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {open && (
          <p className="hidden max-w-[16ch] text-xs leading-tight text-ink/70 sm:block">
            {current.name}. {current.note}.
          </p>
        )}
      </div>
    </div>
  );
}

type IconProps = { className?: string };

/** The painted pointing hand every Indian shop board carries. */
export function PointingHand({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 32 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2 12h12M14 12l-3.5-3.5M14 12l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="square"
      />
      <path
        d="M18 7.5c0-1 .8-1.8 1.8-1.8s1.7.8 1.7 1.8V12m0-2.2c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8V12m0-1.6c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8V16c0 2.8-2.3 5-5.1 5h-2.4c-1.6 0-3-.9-3.7-2.3L17 16.4c-.5-.9-.2-2 .7-2.5.8-.5 1.9-.2 2.4.6l.2.4V7.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Tick({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4 10.5l4 4 8-9"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function Cross({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path
        d="M5 5l10 10M15 5L5 15"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function Half({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path d="M3 10h14" stroke="currentColor" strokeWidth="2.25" strokeLinecap="square" />
    </svg>
  );
}

/** A brush, used once, beside the price that gets painted on. */
export function Brush({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M20 3.5c-1 3.5-5 7.5-9 10.5l-1.5-1.5C12.5 8.5 16.5 4.5 20 3.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 14 6 17.5m0 0c-1 1-2.5 1-3.5 0m3.5 0 1 1c1 1 1 2.5 0 3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="square"
      />
    </svg>
  );
}

/** Painted separator asterisk, drawn rather than typed. */
export function Star({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8 1v14M1.9 4.5l12.2 7M14.1 4.5l-12.2 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

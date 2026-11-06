/**
 * A painted stroke under the price: one pass of a loaded brush.
 * Heaviest where the brush lands, tapering off the end where the
 * bristles lift. Drawn as a filled contour rather than a stroked line,
 * because a stroked line is a ruler and this world has none.
 */
export function BrushStroke({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 22"
      preserveAspectRatio="none"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M3 9C58 3 118 1.5 178 3.5C236 5.4 282 5 316 2.5L316 8.5C282 12.5 236 14.2 178 12.5C118 10.7 58 12 4 18.5Z"
        fill="currentColor"
      />
      <path
        d="M236 5.8C268 5.2 296 4.2 316 2.9L316 7.4C296 9.6 268 11 236 11.6Z"
        fill="currentColor"
        opacity="0.5"
      />
    </svg>
  );
}

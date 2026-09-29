/** Bound Link mark: two linked rings in gold. Placeholder until the logo artwork is added. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <svg width={size * 1.6} height={size} viewBox="0 0 64 40" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="5">
          <rect x="4" y="6" width="32" height="28" rx="14" />
          <rect x="28" y="6" width="32" height="28" rx="14" />
        </g>
      </svg>
      <span className="wordmark">
        WORTHY<b>BOUND</b>
      </span>
    </span>
  );
}

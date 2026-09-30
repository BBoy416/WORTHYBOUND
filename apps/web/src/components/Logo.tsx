import mark from "../assets/logo-mark.png";

/** Bound Link mark (two linked gold links) and the WORTHYBOUND wordmark. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <img src={mark} height={size} alt="" aria-hidden="true" />
      <span className="wordmark">
        WORTHY<b>BOUND</b>
      </span>
    </span>
  );
}

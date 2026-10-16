import orbitMarkUrl from "../assets/orbit-mark.svg";

import { cx } from "./ui";

export const PRODUCT_NAME = "Orbit";

export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cx("brand-mark", className)}
      draggable={false}
      height="32"
      src={orbitMarkUrl}
      width="32"
    />
  );
}

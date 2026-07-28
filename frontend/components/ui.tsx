import type { ReactNode } from "react";
import { useEscape } from "../hooks/use-escape";

export const control =
  "inline-flex h-8 items-center justify-center rounded-control border border-white/10 bg-white/[0.04] px-3 text-sm font-medium text-white transition hover:bg-white/[0.09] disabled:pointer-events-none disabled:opacity-40";
export const primary = `${control} bg-white text-black hover:bg-white/90`;
export const iconButton = `${control} w-8 px-0 text-rork-muted`;
export const input =
  "h-9 w-full rounded-control border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/30";
export const label = "flex flex-col gap-2 text-sm font-medium";
export const muted = "text-xs font-normal text-rork-muted";
export const surface =
  "border border-white/10 bg-rork-surface bg-[linear-gradient(rgb(255_255_255/0.02),rgb(255_255_255/0.02))] shadow-2xl backdrop-blur-2xl";

export function Modal({
  children,
  close,
  className = "",
}: {
  children: ReactNode;
  close: () => void;
  className?: string;
}) {
  useEscape(close);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onMouseDown={close}>
      <section
        className={`${surface} ${className} max-h-[calc(100dvh-2rem)] overflow-hidden rounded-sheet`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

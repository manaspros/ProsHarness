import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class name fragments and resolve Tailwind class
 * conflicts (e.g. `cn("p-2", condition && "p-4")` keeps only "p-4").
 * Standard shadcn/ui helper -- every component in components/ui and
 * components/ imports this.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import clsx, { type ClassValue } from "clsx";

/** Thin wrapper around clsx — stable reference for conditional classnames. */
export function cn(...inputs: ClassValue[]): string {
    return clsx(inputs);
}

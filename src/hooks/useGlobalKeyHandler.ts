/**
 * Install the global keydown handler.
 */
import { useEffect } from "react";
import { handleKeyDown } from "../stores/shortcuts";

export function useGlobalKeyHandler() {
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}

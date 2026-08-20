"use client";

import { useEffect, type ReactNode } from "react";

/**
 * OntoCode is intentionally a light, dense engineering workbench even when
 * the surrounding Operator portal is using another visual preference.
 * Restoring both attributes on unmount keeps this product-specific art
 * direction from leaking into the rest of the portal.
 */
export function OntoCodeThemeBoundary({
  children,
}: {
  children: ReactNode;
}) {
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");
    const previousDensity = root.getAttribute("data-density");
    const previousWorkbench = root.getAttribute("data-ontocode-workbench");
    root.setAttribute("data-theme", "light");
    root.setAttribute("data-density", "compact");
    root.setAttribute("data-ontocode-workbench", "true");
    return () => {
      if (previousTheme) root.setAttribute("data-theme", previousTheme);
      else root.removeAttribute("data-theme");
      if (previousDensity) root.setAttribute("data-density", previousDensity);
      else root.removeAttribute("data-density");
      if (previousWorkbench) {
        root.setAttribute("data-ontocode-workbench", previousWorkbench);
      } else {
        root.removeAttribute("data-ontocode-workbench");
      }
    };
  }, []);

  return children;
}

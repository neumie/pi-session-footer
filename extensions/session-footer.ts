// Compact, animated two-row Pi footer. The public extension entry point stays
// stable; implementation is split into pure domain/layout modules and one
// session-scoped lifecycle controller.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FooterController } from "./controller.ts";

export default function sessionFooter(pi: ExtensionAPI): void {
	new FooterController(pi).register();
}

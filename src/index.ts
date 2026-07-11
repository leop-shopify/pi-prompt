import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptExtension } from "./extension/register.js";

export { takeEditorText } from "./extension/register.js";

export default function piPromptExtension(pi: ExtensionAPI): void {
  registerPromptExtension(pi);
}

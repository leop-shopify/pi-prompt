import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ClipboardImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

interface ClipboardImageModule {
  readClipboardImage(): Promise<ClipboardImage | null>;
  extensionForImageMimeType(mimeType: string): string | null;
}

interface ClipboardTextModule {
  readClipboardText?: () => Promise<string | null>;
}

interface NativeClipboardModule {
  getText(): Promise<string>;
}

export async function readClipboardPaste(): Promise<string | null> {
  try {
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const [imageClipboard, textClipboard] = await Promise.all([
      import(new URL("./utils/clipboard-image.js", entry).href) as Promise<ClipboardImageModule>,
      import(new URL("./utils/clipboard.js", entry).href) as Promise<ClipboardTextModule>,
    ]);
    const image = await imageClipboard.readClipboardImage();
    if (image?.bytes.length) {
      const extension = imageClipboard.extensionForImageMimeType(image.mimeType) ?? "png";
      const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
      await writeFile(filePath, image.bytes, { flag: "wx", mode: 0o600 });
      return filePath;
    }
    if (textClipboard.readClipboardText) return await textClipboard.readClipboardText();
    const nativeClipboard = createRequire(entry)("@mariozechner/clipboard") as NativeClipboardModule;
    return (await nativeClipboard.getText()) || null;
  } catch {
    return null;
  }
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface BrowserLaunchCommand { readonly command: string; readonly args: readonly string[] }
export interface BrowserLauncher { open(url: string): Promise<void> }

export function browserLaunchCommand(url: string, platform = process.platform): BrowserLaunchCommand {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/" || parsed.search) throw new Error("invalid-browser-url");
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

/** Uses only Pi's public argv-based exec API; no shell or private browser helper. */
export function createBrowserLauncher(pi: Pick<ExtensionAPI, "exec">, platform = process.platform): BrowserLauncher {
  return {
    async open(url) {
      const launch = browserLaunchCommand(url, platform);
      const result = await pi.exec(launch.command, [...launch.args], { timeout: 10_000 });
      if (result.code !== 0) throw new Error("browser-launch-failed");
    },
  };
}

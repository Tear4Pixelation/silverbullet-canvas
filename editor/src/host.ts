// The editor talks to its environment only through this interface, so the same
// bundle runs inside SilverBullet's document-editor iframe and standalone.

export interface Host {
  readonly embedded: boolean;
  readOnly(): Promise<boolean>;
  // Called after every committed edit.
  changed(): void;
  navigate(file: string, subpath?: string): void;
  openUrl(url: string): void;
  readFile(path: string): Promise<Uint8Array | null>;
  // Lets the user pick a file in the space; null when cancelled.
  pickFile(): Promise<string | null>;
  prompt(message: string, value?: string): Promise<string | null>;
  notify(message: string, type?: "info" | "error"): void;
}

interface SilverBulletGlobal extends EventTarget {
  syscall(name: string, ...args: unknown[]): Promise<any>;
  sendMessage(type: string, data?: unknown): void;
}

export function silverbullet(): SilverBulletGlobal | undefined {
  return (globalThis as unknown as { silverbullet?: SilverBulletGlobal }).silverbullet;
}

const pageName = (file: string) => file.replace(/\.md$/i, "");

export function silverBulletHost(sb: SilverBulletGlobal): Host {
  return {
    embedded: true,
    async readOnly() {
      try { return (await sb.syscall("system.getMode")) === "ro"; } catch { return false; }
    },
    changed() { sb.sendMessage("file-changed", {}); },
    navigate(file, subpath) {
      const isPage = /\.md$/i.test(file) || !/\.[a-z0-9]+$/i.test(file);
      const target = (isPage ? pageName(file) : file) + (subpath ?? "");
      sb.syscall("editor.navigate", target).catch((error) => console.error(error));
    },
    openUrl(url) { sb.syscall("editor.openUrl", url).catch((error) => console.error(error)); },
    async readFile(path) {
      try { return await sb.syscall("space.readFile", path); } catch { return null; }
    },
    async pickFile() {
      const files: { name: string; lastModified?: number }[] = await sb.syscall("space.listFiles");
      const options = files
        .filter((file) => !file.name.startsWith("_") && !/\.plug\.js$/.test(file.name) && !file.name.startsWith("Library/Std/"))
        .sort((first, second) => (second.lastModified ?? 0) - (first.lastModified ?? 0))
        .map((file) => ({ name: file.name, description: /\.md$/i.test(file.name) ? "page" : "document" }));
      const picked = await sb.syscall("editor.filterBox", "Add file", options, "Pick a page or document to add to the canvas", "Name");
      return picked?.name ?? null;
    },
    async prompt(message, value = "") {
      const result = await sb.syscall("editor.prompt", message, value);
      return result ?? null;
    },
    notify(message, type = "info") {
      sb.syscall("editor.flashNotification", message, type).catch(() => {});
    },
  };
}

export function standaloneHost(onChange: () => void): Host {
  return {
    embedded: false,
    async readOnly() { return false; },
    changed: onChange,
    navigate(file, subpath) { console.info("navigate", file, subpath ?? ""); },
    openUrl(url) { window.open(url, "_blank", "noopener"); },
    async readFile() { return null; },
    async pickFile() { return window.prompt("File path (relative to the vault)", "Note.md"); },
    async prompt(message, value = "") { return window.prompt(message, value); },
    notify(message) { console.info(message); },
  };
}

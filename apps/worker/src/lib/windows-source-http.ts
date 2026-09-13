import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type NativeResult = { id: number; status: number; headers: Record<string, string>; body: string; headersAt: string; bodyAt: string; error?: string };
export const windowsResponseTiming = new WeakMap<Response, { firstByteAt: Date; bodyReceivedAt: Date }>();

/** One persistent Windows HTTP connection owner; the OLX coordinator owns scheduling. */
export class WindowsSourceHttp {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending?: { id: number; resolve: (result: NativeResult) => void; reject: (error: Error) => void };
  private output = "";
  constructor(private readonly allowLoopbackTest = false) {}

  async fetch(url: string, init: RequestInit, maxBytes: number, timeoutMs: number): Promise<Response> {
    if (this.pending) throw new Error("Concurrent Windows source HTTP request");
    const target = new URL(url);
    const loopback = this.allowLoopbackTest && process.env.AMB_PIPELINE_INTEGRATION_TEST === "1" && ["127.0.0.1", "localhost"].includes(target.hostname);
    if ((!loopback && (target.protocol !== "https:" || target.hostname !== "www.olx.ua" || target.port || target.username || target.password)) || (init.method && init.method !== "GET") || init.body) {
      throw new Error("Unsupported Windows source HTTP request");
    }
    init.signal?.throwIfAborted();
    const child = this.ensureChild();
    const id = ++this.sequence;
    const abort = () => this.close(init.signal?.reason instanceof Error ? init.signal.reason : new Error("Windows source request aborted"));
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await new Promise<NativeResult>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        init.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => this.close(new DOMException("Windows source HTTP timed out", "TimeoutError")), timeoutMs);
        child.stdin.write(JSON.stringify({ id, url, headers: Object.fromEntries(new Headers(init.headers)), maxBytes, timeoutMs }) + "\n", error => { if (error) this.close(error); });
      });
      if (result.error) throw new Error(result.error);
      const body = [204, 205, 304].includes(result.status) ? null : Buffer.from(result.body, "base64");
      const response = new Response(body, { status: result.status, headers: result.headers });
      windowsResponseTiming.set(response, { firstByteAt: new Date(result.headersAt), bodyReceivedAt: new Date(result.bodyAt) });
      return response;
    } finally {
      if (timer) clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
    }
  }

  close(error = new Error("Windows source transport closed")): void {
    const child = this.child;
    this.child = undefined;
    const pending = this.pending;
    this.pending = undefined;
    this.output = "";
    pending?.reject(error);
    child?.kill();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const helper = fileURLToPath(new URL("../../../../scripts/windows-source-http.ps1", import.meta.url));
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, ...(this.allowLoopbackTest ? ["-AllowLoopbackTest"] : [])], { windowsHide: true, stdio: "pipe" });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.output += chunk;
      if (this.output.length > 14_000_000) { this.close(new Error("Windows source IPC size exceeded")); return; }
      const end = this.output.indexOf("\n");
      if (end < 0) return;
      try {
        const result = JSON.parse(this.output.slice(0, end)) as NativeResult;
        this.output = this.output.slice(end + 1);
        if (!this.pending || result.id !== this.pending.id) throw new Error("Windows source IPC response mismatch");
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(result);
      } catch { this.close(new Error("Invalid Windows source HTTP response")); }
    });
    child.stderr.resume();
    child.once("error", error => { if (this.child === child) this.close(error); });
    child.once("exit", () => { if (this.child === child) this.close(new Error("Windows source HTTP helper exited")); });
    return child;
  }
}

const windowsHttp = new WindowsSourceHttp();
export function fetchSourceResponse(url: string, init: RequestInit, source: string, maxBytes: number, timeoutMs: number): Promise<Response> {
  if (process.platform === "win32" && source === "OLX" && new URL(url).hostname === "www.olx.ua") {
    return windowsHttp.fetch(url, init, maxBytes, timeoutMs);
  }
  return fetch(url, init);
}
export function closeWindowsSourceHttp(): void { windowsHttp.close(); }

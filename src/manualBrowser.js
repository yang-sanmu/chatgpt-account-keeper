import { EventEmitter } from "node:events";

// A small browser-control adapter for human-operated windows. Unlike a
// Playwright attachment, discovery does not enable Runtime/Network/Log, install
// utility worlds, intercept requests or emulate focus/media on every page.
export async function connectManualBrowser(endpoint, { connect }) {
  const address = new URL(endpoint);
  if (address.hostname !== "127.0.0.1") throw new Error("手动浏览器必须使用本机控制端点");
  if (address.protocol === "http:") {
    const response = await fetch(new URL("/json/version", address), { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("无法读取手动浏览器控制端点");
    endpoint = (await response.json()).webSocketDebuggerUrl;
  }
  const websocket = new URL(endpoint);
  if (websocket.protocol !== "ws:" || websocket.hostname !== "127.0.0.1") {
    throw new Error("手动浏览器必须使用本机 WebSocket 端点");
  }
  const connection = await connect(endpoint);
  const browser = new ManualBrowser(connection);
  try {
    await browser.context.initialize();
    return browser;
  } catch (error) {
    connection.close();
    throw error;
  }
}

class ManualBrowser {
  constructor(connection) {
    this.connection = connection;
    this.connected = true;
    this.context = new ManualContext(this);
    connection.onUnexpectedClose(() => {
      this.connected = false;
      this.context.didClose();
    });
  }
  contexts() { return [this.context]; }
  isConnected() { return this.connected; }
  async newBrowserCDPSession() {
    return { send: (method, params = {}) => this.connection.send(method, params) };
  }
  async close() {
    if (!this.connected) return;
    try { await this.connection.send("Browser.close"); }
    catch (error) { if (this.connected) throw error; }
  }
}

class ManualContext extends EventEmitter {
  constructor(browser) {
    super();
    this.browser = browser;
    this.connection = browser.connection;
    this.targets = new Map();
    this.sessions = new Set();
    this.closed = false;
    this.initialized = false;
    this.connection.onEvent(message => {
      const { method, params } = message;
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
        this.record(params.targetInfo);
      } else if (method === "Target.targetDestroyed") {
        const page = this.targets.get(params.targetId);
        if (!page) return;
        this.targets.delete(params.targetId);
        page.didClose();
        if (this.initialized && !this.targets.size) {
          // Chrome may keep background apps alive after its final window closes.
          // Let the existing BrowserRun lifecycle reclaim that process as well.
          this.didClose();
        }
      }
      for (const session of this.sessions) {
        if (message.sessionId === session.id) session.emit(method, params);
        if (method === "Target.detachedFromTarget" && params.sessionId === session.id) session.didDetach();
      }
    });
  }
  async initialize() {
    const filter = [{ type: "page" }];
    await this.connection.send("Target.setDiscoverTargets", { discover: true, filter });
    const { targetInfos } = await this.connection.send("Target.getTargets", { filter });
    for (const info of targetInfos) this.record(info);
    this.initialized = true;
  }
  record(info) {
    if (this.closed || info.type !== "page" || info.subtype === "prerender") return null;
    let page = this.targets.get(info.targetId);
    if (page) page.info = info;
    else {
      page = new ManualPage(this, info);
      this.targets.set(info.targetId, page);
      this.emit("page", page);
    }
    return page;
  }
  pages() { return [...this.targets.values()]; }
  async newPage() {
    if (this.closed) throw new Error("浏览器已关闭");
    const { targetId } = await this.connection.send("Target.createTarget", { url: "about:blank" });
    const { targetInfo } = await this.connection.send("Target.getTargetInfo", { targetId });
    return this.record(targetInfo);
  }
  async newCDPSession(page) {
    if (this.closed || page.context !== this || page.isClosed()) throw new Error("浏览器页面已关闭");
    const { sessionId } = await this.connection.send("Target.attachToTarget", { targetId: page.info.targetId, flatten: true });
    if (this.closed || page.isClosed()) {
      await this.connection.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      throw new Error("浏览器页面已关闭");
    }
    const session = new ManualSession(this, sessionId);
    this.sessions.add(session);
    return session;
  }
  close() { return this.browser.close(); }
  didClose() {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.targets.values()) page.didClose();
    this.targets.clear();
    for (const session of [...this.sessions]) session.didDetach();
    this.emit("close");
  }
}

class ManualSession extends EventEmitter {
  constructor(context, id) {
    super();
    this.context = context;
    this.id = id;
    this.detached = false;
  }
  send(method, params = {}, options) {
    if (this.detached) return Promise.reject(new Error("浏览器页面控制连接已关闭"));
    return this.context.connection.send(method, params, this.id, options);
  }
  async detach() {
    if (this.detached) return;
    this.didDetach();
    await this.context.connection.send("Target.detachFromTarget", { sessionId: this.id });
  }
  didDetach() {
    if (this.detached) return;
    this.detached = true;
    this.context.sessions.delete(this);
    this.emit("disconnected");
  }
}

class ManualPage extends EventEmitter {
  constructor(context, info) { super(); this.context = context; this.info = info; this.closed = false; }
  url() { return this.info.url; }
  isClosed() { return this.closed; }
  didClose() { if (!this.closed) { this.closed = true; this.emit("close"); } }
  async bringToFront() { await this.context.connection.send("Target.activateTarget", { targetId: this.info.targetId }); }
  async close() { await this.context.connection.send("Target.closeTarget", { targetId: this.info.targetId }); }

  async goto(url, { waitUntil = "load", timeout = 30_000 } = {}) {
    if (!["commit", "load", "domcontentloaded"].includes(waitUntil)) throw new Error("手动窗口不支持此导航等待方式");
    const session = await this.context.newCDPSession(this);
    const events = [];
    let navigation;
    let timer;
    let done;
    let failed;
    const ready = new Promise((resolve, reject) => { done = resolve; failed = reject; });
    // Attach a rejection handler before sending commands: a closed tab or fast
    // navigation failure can otherwise reject while Page.navigate is pending.
    ready.catch(() => {});
    const check = () => {
      if (!navigation) return;
      if (waitUntil === "commit" || !navigation.loaderId || events.some(event =>
        event.frameId === navigation.frameId && event.loaderId === navigation.loaderId
        && event.name === (waitUntil === "load" ? "load" : "DOMContentLoaded"))) done();
    };
    session.on("Page.lifecycleEvent", event => { events.push(event); check(); });
    session.once("disconnected", () => failed(new Error("导航期间页面已关闭")));
    try {
      timer = setTimeout(() => failed(new Error(`页面导航超过 ${timeout}ms`)), timeout);
      await session.send("Page.enable");
      await session.send("Page.setLifecycleEventsEnabled", { enabled: true });
      navigation = await Promise.race([session.send("Page.navigate", { url }, { timeoutMs: timeout }), ready]);
      if (navigation.errorText) throw new Error(`页面导航失败：${navigation.errorText}`);
      check();
      await ready;
      return null;
    } finally {
      clearTimeout(timer);
      await session.detach().catch(() => {});
    }
  }

  // Open-page health sampling calls evaluate only on a ChatGPT page. This
  // on-demand command needs no Runtime.enable and leaves no init script behind.
  async evaluate(fn, arg) {
    if (typeof fn !== "function") throw new TypeError("手动页面仅支持函数求值");
    const origin = new URL(this.url()).origin;
    const expression = `(() => { if (location.origin !== ${JSON.stringify(origin)}) throw new Error('Page origin changed'); return (${fn.toString()})(${JSON.stringify(arg) ?? "undefined"}); })()`;
    const session = await this.context.newCDPSession(this);
    try {
      const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
      }, { timeoutMs: 25_000 });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    } finally { await session.detach().catch(() => {}); }
  }
}

// Compatibility entry point for the earlier authentication-only experiment.
// Strict runs install the combined barrier once, never alongside the production
// identity barrier. Product integration remains gated by M1 acceptance.
export { installBrowserStartupBarrier as installProxyAuthBarrier, proxyAuthResponse } from "./browserStartupBarrier.js";

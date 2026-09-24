import { HttpsProxyAgent } from 'https-proxy-agent';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Honour HTTPS_PROXY / HTTP_PROXY / NO_PROXY. Node's built-in fetch ignores them, and many users can
 * reach Polymarket only through a proxy. The CLOB SDK (axios) already reads them itself; this covers
 * fetch (PMWallets REST, CLOB market data) and returns an agent for the WebSocket.
 */
export function applyProxyFromEnv(env: NodeJS.ProcessEnv = process.env): { agent?: HttpsProxyAgent<string>; proxy?: string } {
  const proxy = env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'];
  if (!proxy) return {};
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return { agent: new HttpsProxyAgent(proxy), proxy: proxy.replace(/\/\/[^@/]*@/, '//***@') };
}

import { isAbsolute, resolve } from 'node:path';
import { loopbackEndpoint } from './rpc';

export interface DesktopConfig {
  appId: string;
  appSecretEnv: string;
  chatId: string;
  ownerOpenId: string;
  projectId: string;
  projectRoot: string;
  threadId: string;
  endpoint: string;
  connectionFile: string;
  stateFile: string;
  model?: string;
  requireMention: boolean;
  maxQueue: number;
}
export function parseDesktopConfig(raw: unknown): DesktopConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Desktop config must be an object');
  const r = raw as Record<string, unknown>;
  const str = (key: string): string => { const v = r[key]; if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing ${key}`); return v.trim(); };
  const absolute = (key: string): string => { const v = str(key); if (!isAbsolute(v)) throw new Error(`${key} must be absolute`); return resolve(v); };
  const config: DesktopConfig = {
    appId: str('appId'), appSecretEnv: str('appSecretEnv'), chatId: str('chatId'), ownerOpenId: str('ownerOpenId'),
    projectId: str('projectId'), projectRoot: absolute('projectRoot'), threadId: str('threadId'),
    endpoint: loopbackEndpoint(str('endpoint')), connectionFile: absolute('connectionFile'), stateFile: absolute('stateFile'),
    requireMention: r.requireMention !== false, maxQueue: 20,
    ...(typeof r.model === 'string' && r.model.trim() ? { model: r.model.trim() } : {}),
  };
  if (!/^cli_[a-zA-Z0-9]+$/.test(config.appId) || !/^oc_[a-zA-Z0-9]+$/.test(config.chatId) || !/^ou_[a-zA-Z0-9]+$/.test(config.ownerOpenId)) throw new Error('Expected Feishu app/chat/open IDs');
  if (!/^[A-Z][A-Z0-9_]*$/.test(config.appSecretEnv)) throw new Error('Invalid appSecretEnv name');
  return config;
}

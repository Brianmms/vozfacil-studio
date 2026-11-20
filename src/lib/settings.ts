const STORAGE_KEY = 'vozfacil_deepseek_settings_v1';
const SETTINGS_EVENT = 'vozfacil:settings-changed';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';

export interface DeepSeekSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function normalizeBaseUrl(raw?: string): string {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_DEEPSEEK_BASE_URL;
}

function normalizeModel(raw?: string): string {
  const trimmed = String(raw || '').trim();
  return trimmed || DEFAULT_DEEPSEEK_MODEL;
}

export function getDeepSeekSettings(): DeepSeekSettings {
  const defaults: DeepSeekSettings = {
    apiKey: '',
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    model: DEFAULT_DEEPSEEK_MODEL,
  };

  if (typeof window === 'undefined') {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<DeepSeekSettings>;
    return {
      apiKey: typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '',
      baseUrl: normalizeBaseUrl(parsed?.baseUrl),
      model: normalizeModel(parsed?.model),
    };
  } catch {
    return defaults;
  }
}

export function saveDeepSeekSettings(partial: Partial<DeepSeekSettings>): DeepSeekSettings {
  const current = getDeepSeekSettings();
  const next: DeepSeekSettings = {
    apiKey: partial.apiKey !== undefined ? String(partial.apiKey).trim() : current.apiKey,
    baseUrl:
      partial.baseUrl !== undefined ? normalizeBaseUrl(partial.baseUrl) : current.baseUrl,
    model: partial.model !== undefined ? normalizeModel(partial.model) : current.model,
  };

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent<DeepSeekSettings>(SETTINGS_EVENT, { detail: next }));
    } catch {
      // Ignore storage quota / restricted storage errors gracefully
    }
  }

  return next;
}

export function clearDeepSeekApiKey(): DeepSeekSettings {
  return saveDeepSeekSettings({ apiKey: '' });
}

export function hasDeepSeekApiKey(): boolean {
  return Boolean(getDeepSeekSettings().apiKey);
}

export function subscribeSettingsChange(
  listener: (settings: DeepSeekSettings) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const onCustom = (event: Event) => {
    const custom = event as CustomEvent<DeepSeekSettings>;
    listener(custom.detail || getDeepSeekSettings());
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      listener(getDeepSeekSettings());
    }
  };

  window.addEventListener(SETTINGS_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

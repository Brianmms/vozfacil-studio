import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const ENV_PATH = path.resolve(process.cwd(), '.env');
const PLACEHOLDER_KEYS = new Set(['', 'tu_api_key_aqui', 'your_api_key_here', 'sk-xxxx']);

export function getDeepSeekConfig() {
  let apiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  let baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim();
  let model = (process.env.DEEPSEEK_MODEL || 'deepseek-flash').trim();
  let port = Number(process.env.PORT || 3001);

  if (PLACEHOLDER_KEYS.has(apiKey) && fs.existsSync(ENV_PATH)) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
      if (parsed.DEEPSEEK_API_KEY) apiKey = parsed.DEEPSEEK_API_KEY.trim();
      if (parsed.DEEPSEEK_BASE_URL) baseUrl = parsed.DEEPSEEK_BASE_URL.trim();
      if (parsed.DEEPSEEK_MODEL) model = parsed.DEEPSEEK_MODEL.trim();
      if (parsed.PORT) port = Number(parsed.PORT) || port;
    } catch {
      // Ignore transient read/parse issues while user edits .env
    }
  }

  baseUrl = baseUrl.replace(/\/+$/, '');
  const hasApiKey = !PLACEHOLDER_KEYS.has(apiKey);

  return {
    apiKey,
    hasApiKey,
    baseUrl,
    model,
    port,
  };
}

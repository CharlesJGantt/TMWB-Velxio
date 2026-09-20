/**
 * Save-to-Media-Library: POSTs the current workspace to the Drupal
 * tmwb_velxio module's /api/velxio/save-project endpoint, so a project
 * built in the sandbox lands directly in the site's media library as a
 * "Velxio Project" media item, ready to embed in an article — no
 * export/download/manual-import round trip.
 *
 * Connection (Drupal base URL + bearer token, generated once at
 * /admin/config/content/velxio on the Drupal side) is stored in
 * localStorage, not sent anywhere else. This is a single-editor internal
 * tool, not a multi-tenant feature — a lightweight prompt-once flow is
 * the right amount of UI for it, not a full settings panel.
 */

import { buildVlxPayload } from '../utils/vlxFile';

const LS_URL_KEY = 'velxio_drupal_save_url';
const LS_TOKEN_KEY = 'velxio_drupal_save_token';

export interface DrupalSaveConfig {
  url: string;
  token: string;
}

export function getSaveConfig(): DrupalSaveConfig | null {
  const url = localStorage.getItem(LS_URL_KEY);
  const token = localStorage.getItem(LS_TOKEN_KEY);
  if (!url || !token) return null;
  return { url, token };
}

export function setSaveConfig(url: string, token: string): void {
  localStorage.setItem(LS_URL_KEY, url.trim().replace(/\/+$/, ''));
  localStorage.setItem(LS_TOKEN_KEY, token.trim());
}

export function clearSaveConfig(): void {
  localStorage.removeItem(LS_URL_KEY);
  localStorage.removeItem(LS_TOKEN_KEY);
}

/**
 * Prompts for the Drupal site URL and API token if not already configured.
 * Returns null if the user cancels either prompt.
 */
export function ensureSaveConfig(): DrupalSaveConfig | null {
  const existing = getSaveConfig();
  if (existing) return existing;

  const url = window.prompt(
    'Drupal site URL for Save to Media Library (e.g. https://themakersworkbench.com):',
    'https://themakersworkbench.com',
  );
  if (!url) return null;

  const token = window.prompt(
    'API token (generate one at /admin/config/content/velxio on that site — it is only shown once there):',
  );
  if (!token) return null;

  setSaveConfig(url, token);
  return getSaveConfig();
}

export interface SaveToMediaLibraryResult {
  mediaId: number;
  name: string;
  editUrl: string;
  projectFileUrl: string;
}

export async function saveProjectToMediaLibrary(
  config: DrupalSaveConfig,
  opts: { name?: string } = {},
): Promise<SaveToMediaLibraryResult> {
  const payload = buildVlxPayload(opts);

  let res: Response;
  try {
    res = await fetch(`${config.url}/api/velxio/save-project`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(payload),
    });
  }
  catch {
    throw new Error(
      `Could not reach ${config.url} — check the URL, and that its CORS allowlist includes ${window.location.origin}.`,
    );
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body && typeof body.error === 'string' ? body.error : `Save failed (HTTP ${res.status}).`;
    throw new Error(message);
  }

  return {
    mediaId: body.media_id,
    name: body.name,
    editUrl: body.edit_url,
    projectFileUrl: body.project_file_url,
  };
}

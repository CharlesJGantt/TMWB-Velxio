/**
 * Loads a .vlx-shaped project from an arbitrary URL (e.g. a file Drupal
 * serves for a specific tutorial's embed) into the editor + simulator
 * stores. This is the piece the stock app doesn't ship: examples only
 * load from the bundled `data/examples.ts` list (see loadExample.ts).
 *
 * Content from an external URL is untrusted input -- it goes through the
 * exact same schema validation as a hand-picked .vlx file import, never
 * assumed well-formed just because the fetch succeeded.
 */
import { validatePayload, loadVlxPayload, VlxParseError } from './vlxFile';

export async function loadProjectFromUrl(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new VlxParseError(
      `Could not reach project URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new VlxParseError(`Project URL returned HTTP ${response.status}.`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new VlxParseError(
      `Project URL did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const payload = validatePayload(data);
  loadVlxPayload(payload);
}

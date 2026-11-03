export const MAP_RETRY_MS = 30_000;

/** The wall has no mouse or keyboard, so a map that failed to load (Wi-Fi not up yet at boot) must
 *  retry by itself. A resolved null means no key is configured, which a reload can't change. */
export async function reloadOnMapFailure(mount: Promise<unknown>, reload: () => void): Promise<void> {
  try {
    await mount;
  } catch {
    setTimeout(reload, MAP_RETRY_MS);
  }
}

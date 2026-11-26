// Capture must stop even if saving the final draft is slow or fails.
export async function stopThenSave<T>(
  stop: () => Promise<T>,
  save: (stopped: T) => Promise<unknown>,
  reportSaveError: (error: unknown) => void,
): Promise<T> {
  const stopped = await stop();
  void Promise.resolve()
    .then(() => save(stopped))
    .catch(reportSaveError);
  return stopped;
}

// An acknowledged stop wins over an older manifest when the disk write failed.
export function reconcileStopped<T extends { id: string; active: boolean }>(
  archive: T[],
  current: T | null,
): T[] {
  return archive.map((saved) =>
    current?.id === saved.id && !current.active && saved.active
      ? current
      : saved,
  );
}

/** A call length in words: under a minute shows seconds, otherwise the
 * nearest minute ("1 hr 18 min", "34 min", "9 sec"). Returns i18n parts. */
export function durationParts(ms: number): { key: string; n: number }[] {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return [{ key: "calls.duration.sec", n: seconds }];
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [
    ...(hours ? [{ key: "calls.duration.hr", n: hours }] : []),
    ...(rest ? [{ key: "calls.duration.min", n: rest }] : []),
  ];
}

export function humanDuration(
  ms: number,
  t: (key: string, options: { n: number }) => string,
): string {
  return durationParts(ms)
    .map(({ key, n }) => t(key, { n }))
    .join(" ");
}

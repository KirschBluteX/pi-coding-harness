export interface Clock {
  now(): number;
  monotonicNow(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000,
};

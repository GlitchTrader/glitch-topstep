/** Sync stores (tests) and worker facades both satisfy this. Callers must await. */
export type MayPromise<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<R>
    : T[K];
};

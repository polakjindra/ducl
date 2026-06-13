/**
 * Push-based async iterator. Consumers pull items with `for await`, producers
 * call push() to enqueue and close() / throw() to signal completion or error.
 */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(done: boolean) => void> = [];
  private closed = false;
  private error: unknown = undefined;

  /** Enqueue an item. Throws if the queue is already closed. */
  push(item: T): void {
    if (this.closed) throw new Error("AsyncQueue: push after close");
    this.items.push(item);
    this.waiters.shift()?.call(undefined, false);
  }

  /** Signal end-of-stream. All pending and future pulls resolve with `done: true`. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(true);
  }

  /** Signal an error. The next pull rejects; subsequent ones resolve done. */
  error_push(err: unknown): void {
    this.error = err;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(true);
  }

  async next(): Promise<IteratorResult<T>> {
    while (this.items.length === 0) {
      if (this.closed) {
        if (this.error !== undefined) {
          const e = this.error;
          this.error = undefined;
          throw e;
        }
        return { value: undefined as unknown as T, done: true };
      }
      await new Promise<boolean>((res) => this.waiters.push(res));
    }
    return { value: this.items.shift() as T, done: false };
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined as unknown as T, done: true });
  }

  throw(err?: unknown): Promise<IteratorResult<T>> {
    this.error_push(err);
    return Promise.resolve({ value: undefined as unknown as T, done: true });
  }
}

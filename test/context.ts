import { test as bunTest } from "bun:test";

type Cleanup = () => void | Promise<void>;

interface TestContext {
  after(cleanup: Cleanup): void;
}

/** Runs a Bun test and executes registered cleanup callbacks in reverse order. */
export default function test(name: string, body: (context: TestContext) => void | Promise<void>): void {
  bunTest(name, async () => {
    const cleanups: Cleanup[] = [];
    try {
      await body({ after: (cleanup) => cleanups.push(cleanup) });
    } finally {
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        await cleanups[index]!();
      }
    }
  });
}

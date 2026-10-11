export interface TransactionRunner {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
}

export class TransactionManager {
  private current: TransactionRunner | null = null;

  async run<T>(fn: (runner: TransactionRunner) => Promise<T>): Promise<T> {
    const runner = await this.createRunner();
    this.current = runner;
    try {
      const result = await fn(runner);
      await runner.commit();
      return result;
    } catch (error) {
      await runner.rollback();
      throw error;
    } finally {
      await runner.release();
      this.current = null;
    }
  }

  getCurrent(): TransactionRunner | null {
    return this.current;
  }

  private async createRunner(): Promise<TransactionRunner> {
    return {
      commit: async () => {},
      rollback: async () => {},
      release: async () => {},
      query: async () => [],
    };
  }
}

export const TRANSACTION_MANAGER = Symbol('TRANSACTION_MANAGER');
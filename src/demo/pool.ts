// Demo stub pool so the demo file parses standalone.
export const pool = {
  query: async (_sql: string) => ({ rows: [] as unknown[] }),
};

import { INSTRUCTION_COLUMNS } from "./controls.js";
import { toCsv } from "./csv.js";
import { JOURNAL_COLUMNS } from "./movements.js";
import { REGISTER_COLUMNS } from "./register.js";

export const TEMPLATES = {
  register: REGISTER_COLUMNS,
  journal: JOURNAL_COLUMNS,
  instructions: INSTRUCTION_COLUMNS,
} as const;

const EXAMPLES: Record<keyof typeof TEMPLATES, Record<string, string>> = {
  register: {
    holder_id: "EXAMPLE-HOLDER-001",
    holder_name: "Example Holder",
    account: "GEXAMPLE_HOLDER",
    units: "100.5",
    status: "active",
  },
  journal: {
    ref: "EXAMPLE-JOURNAL-001",
    date: "2026-10-01",
    type: "transfer",
    from_account: "GEXAMPLE_SENDER",
    to_account: "GEXAMPLE_HOLDER",
    units: "10.5",
  },
  instructions: {
    ref: "EXAMPLE-INSTRUCTION-001",
    type: "clawback",
    account: "GEXAMPLE_HOLDER",
    units: "5.5",
    issued_at: "2026-10-01T12:00:00Z",
    approved_by: "Example Approver",
    reason: "Illustrative clawback instruction",
  },
};

/** Example rows illustrate formats only; replace their placeholders before importing. */
export function templateCsv(kind: string, { example = false } = {}): string | undefined {
  if (!Object.hasOwn(TEMPLATES, kind)) return undefined;
  const name = kind as keyof typeof TEMPLATES;
  return toCsv([...TEMPLATES[name]], example ? [EXAMPLES[name]] : []);
}
